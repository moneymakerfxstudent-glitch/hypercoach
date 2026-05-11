import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Dumbbell, Plus, Minus, Check, X, ChevronLeft, ChevronRight,
  Home as HomeIcon, History as HistoryIcon, Settings as SettingsIcon, Flame,
  TrendingUp, Trophy, Target, Save, Download, Trash2, Search,
  Activity, Zap, Award, Clock, BarChart3, Edit3, ArrowRight,
  CheckCircle2, AlertTriangle, Info, Play, Square, Repeat,
  LifeBuoy, Shield, Smartphone, Wifi, WifiOff, Pause, PlayCircle,
  Sliders, RotateCcw,
} from 'lucide-react';
import { useInstallPrompt } from './useInstallPrompt.js';
import { InstallModal } from './InstallModal.jsx';
import {
  roundToAvailable, directionForTag, profileForExercise,
  availableWeights, describeProfile, DEFAULT_PROFILE, PROFILE_TYPES,
} from './loadingProfiles.js';

// ============================================================
// CONSTANTS
// ============================================================
const DEFAULT_SETTINGS = {
  unit: 'kg',
  increment: 2.5, // legacy — still used as fallback for old workouts
  targetMin: 7,
  targetMax: 12,
  targetIdeal: 9,
  // Global default loading profile, used when an exercise has no override
  defaultProfile: { ...DEFAULT_PROFILE },
  // Per-exercise loading profiles, keyed by exercise name
  exerciseProfiles: {},
};

const COMMON_EXERCISES = [
  { name: 'Incline Bench Press', group: 'Chest' },
  { name: 'Flat Bench Press', group: 'Chest' },
  { name: 'Dumbbell Bench Press', group: 'Chest' },
  { name: 'Cable Fly', group: 'Chest' },
  { name: 'Pec Deck', group: 'Chest' },
  { name: 'Lat Pulldown', group: 'Back' },
  { name: 'Pull Up', group: 'Back' },
  { name: 'Barbell Row', group: 'Back' },
  { name: 'Cable Row', group: 'Back' },
  { name: 'Chest Supported Row', group: 'Back' },
  { name: 'Overhead Press', group: 'Shoulders' },
  { name: 'Dumbbell Shoulder Press', group: 'Shoulders' },
  { name: 'Lateral Raise', group: 'Shoulders' },
  { name: 'Rear Delt Fly', group: 'Shoulders' },
  { name: 'Back Squat', group: 'Legs' },
  { name: 'Front Squat', group: 'Legs' },
  { name: 'Hack Squat', group: 'Legs' },
  { name: 'Leg Press', group: 'Legs' },
  { name: 'Romanian Deadlift', group: 'Legs' },
  { name: 'Leg Curl', group: 'Legs' },
  { name: 'Leg Extension', group: 'Legs' },
  { name: 'Calf Raise', group: 'Legs' },
  { name: 'Bicep Curl', group: 'Arms' },
  { name: 'Hammer Curl', group: 'Arms' },
  { name: 'Preacher Curl', group: 'Arms' },
  { name: 'Tricep Pushdown', group: 'Arms' },
  { name: 'Skull Crusher', group: 'Arms' },
  { name: 'Cable Tricep Extension', group: 'Arms' },
];

const STORAGE_KEYS = {
  history: 'hypercoach:history:v1',
  settings: 'hypercoach:settings:v1',
};

// ============================================================
// UTILITIES
// ============================================================
const epley1RM = (w, r) => w * (1 + r / 30);
const weightForReps = (e1rm, r) => e1rm / (1 + r / 30);
// (roundIncrement was removed — loading profiles handle all snapping now.
// See loadingProfiles.js)

const fmt = (n) => {
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? `${n}` : `${parseFloat(n.toFixed(1))}`;
};
const fmtWeight = (w, unit) => `${fmt(w)}${unit}`;

function calcWeeklyStreak(history) {
  // Only completed workouts count toward the streak.
  const completed = history.filter(w => w.status === 'completed' || w.status === undefined);
  if (!completed.length) return 0;
  const startOfWeek = (d) => {
    const x = new Date(d);
    const day = x.getDay() || 7;
    x.setDate(x.getDate() - day + 1);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  const weeks = new Set(completed.map(w => startOfWeek(w.startedAt)));
  let cursor = startOfWeek(Date.now());
  let streak = 0;
  if (weeks.has(cursor)) {
    while (weeks.has(cursor)) { streak++; cursor -= 7 * 86400000; }
  } else {
    cursor -= 7 * 86400000;
    while (weeks.has(cursor)) { streak++; cursor -= 7 * 86400000; }
  }
  return streak;
}

function fmtRelativeDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const days = Math.floor((now - d) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ============================================================
// RECOMMENDATION ENGINE
// ============================================================
//
// The internal recommendation functions produce IDEAL theoretical weights.
// They do NOT round to gym-realistic increments — that's the job of the
// loading profile, applied at the orchestrator boundary in
// getWorkoutRecommendation. Keeping it this way means the engine stays
// pure-math and the profile logic lives in one place.
function recommendNextSet(lastSet, allSetsThisExercise, settings) {
  const { weight, reps, failure, form } = lastSet;
  const { targetMin, targetMax, targetIdeal } = settings;
  const e1rm = epley1RM(weight, reps);

  // Bad form override — biggest cut, ignore other factors
  if (form === 'bad') {
    return {
      weight: weight * 0.85,
      repRange: [targetMin, targetMax],
      targetReps: targetIdeal,
      reason: `Form broke down on that set. Cutting load so the next set is technically clean.`,
      e1rm,
      tag: 'reset',
    };
  }

  // Count working sets taken to failure (incl. this one) for accumulated fatigue
  const priorFailureSets = allSetsThisExercise.filter(
    s => s.type === 'working' && s.failure
  ).length;
  // 2.5% cut per failure set, floored at 8% total
  const fatigueDiscount = Math.max(0.92, 1 - 0.025 * priorFailureSets);

  let baseWeight;
  let reason;
  let tag = 'on-track';
  let targetReps = targetIdeal;

  if (reps <= 5) {
    baseWeight = weightForReps(e1rm, targetIdeal);
    tag = 'too-heavy';
    targetReps = targetIdeal;
    reason = `${fmtWeight(weight, settings.unit)} × ${reps} is too heavy for hypertrophy. Dropping to land you in the ${targetMin}–${targetMax} range.`;
  } else if (reps === 6) {
    baseWeight = weight * 0.95;
    tag = 'adjust';
    targetReps = targetIdeal;
    reason = `6 reps is just under the band. Small drop to bring you back inside ${targetMin}–${targetMax}.`;
  } else if (reps >= targetMin && reps <= targetMax) {
    if (failure) {
      baseWeight = weight;
      targetReps = Math.max(targetMin, Math.min(reps, reps - Math.floor(priorFailureSets / 2)));
      reason = `${reps} reps to failure was on target. Slight cut for fatigue keeps the next set in the band.`;
    } else {
      baseWeight = weight;
      tag = 'push';
      targetReps = Math.min(targetMax, reps + 2);
      reason = `${reps} reps but not at failure — repeat the load and push closer to the limit.`;
    }
  } else {
    // reps > targetMax — bump up. The orchestrator will round UP via the
    // 'progress' tag, so a slight bump above current is enough; the profile
    // will land on the next real weight.
    baseWeight = Math.max(weightForReps(e1rm, targetIdeal), weight * 1.025);
    tag = 'progress';
    targetReps = targetIdeal;
    reason = `${reps} reps means the load was light. Bumping up to bring you back to ${targetMin}–${targetMax}.`;
  }

  // Apply fatigue discount only when the last set was to failure.
  const finalIdealWeight = baseWeight * (failure ? fatigueDiscount : 1);

  return {
    weight: finalIdealWeight,
    repRange: [targetMin, targetMax],
    targetReps,
    reason,
    e1rm,
    tag,
  };
}

function recommendOpeningSet(exerciseName, history, settings) {
  const past = history
    .flatMap(w => w.exercises
      .filter(e => e.name === exerciseName)
      .map(e => ({ ...e, when: w.startedAt }))
    )
    .sort((a, b) => b.when - a.when);

  if (!past.length) {
    return {
      weight: null,
      repRange: [settings.targetMin, settings.targetMax],
      reason: `First time logging ${exerciseName}. Pick a weight you can hit for ~8 clean reps. We'll calibrate from your first set.`,
      isFirstTime: true,
      tag: 'calibrate',
    };
  }

  const last = past[0];
  const working = last.sets.filter(s => s.type === 'working');
  if (!working.length) {
    return {
      weight: null,
      repRange: [settings.targetMin, settings.targetMax],
      reason: 'No working sets in the last session. Pick a weight for ~8 reps to recalibrate.',
      isFirstTime: true,
      tag: 'calibrate',
    };
  }

  const top = working.reduce((b, s) =>
    epley1RM(s.weight, s.reps) > epley1RM(b.weight, b.reps) ? s : b
  );
  const repTarget = Math.min(settings.targetMax, top.reps + 1);

  return {
    weight: top.weight,
    repRange: [Math.max(settings.targetMin, top.reps), settings.targetMax],
    targetReps: repTarget,
    reason: `Last session you hit ${top.weight}${settings.unit} × ${top.reps}. Target ${top.weight}${settings.unit} × ${repTarget}+ to push progression.`,
    isFirstTime: false,
    previous: top,
    tag: 'progress',
  };
}

// ============================================================
// PR & PROGRESSION LOGIC
// ============================================================
function exerciseSessions(exerciseName, history) {
  // Only completed workouts count as session history for recommendations,
  // PRs, and progression targets. Paused/discarded workouts are ignored
  // here — they're tracked in history but they're not "what you did last
  // session" for engine purposes.
  return history
    .filter(w => w.status === 'completed' || w.status === undefined) // undefined for backward compat
    .flatMap(w => w.exercises
      .filter(e => e.name === exerciseName)
      .map(e => ({ ...e, when: w.startedAt, workoutId: w.id }))
    )
    .sort((a, b) => a.when - b.when);
}

function bestE1RM(exerciseName, history) {
  let best = 0;
  exerciseSessions(exerciseName, history).forEach(s => {
    s.sets.filter(set => set.type === 'working').forEach(set => {
      const e = epley1RM(set.weight, set.reps);
      if (e > best) best = e;
    });
  });
  return best;
}

function detectExercisePRs(currExercise, history) {
  // Working-only: warm-ups never count as PRs
  const previous = history.flatMap(w => w.exercises.filter(e => e.name === currExercise.name));
  const allPrevSets = previous.flatMap(e => e.sets).filter(s => s.type === 'working');
  const currSets = currExercise.sets.filter(s => s.type === 'working');
  const prs = [];

  // e1RM PR — must come from a set with good/okay form
  const currBest = currSets
    .filter(s => s.form !== 'bad')
    .reduce((m, s) => Math.max(m, epley1RM(s.weight, s.reps)), 0);
  const prevBest = allPrevSets.reduce((m, s) => Math.max(m, epley1RM(s.weight, s.reps)), 0);
  if (currBest > prevBest && prevBest > 0) {
    prs.push({ type: 'e1rm', label: 'e1RM PR', value: currBest, prev: prevBest });
  }

  // Top weight PR
  const currMaxW = currSets
    .filter(s => s.reps >= 1 && s.form !== 'bad')
    .reduce((m, s) => Math.max(m, s.weight), 0);
  const prevMaxW = allPrevSets
    .filter(s => s.reps >= 1)
    .reduce((m, s) => Math.max(m, s.weight), 0);
  if (currMaxW > prevMaxW && prevMaxW > 0) {
    prs.push({ type: 'weight', label: 'Top Weight PR', value: currMaxW, prev: prevMaxW });
  }

  // Rep PR at a specific weight
  const repRecords = {};
  allPrevSets.forEach(s => {
    repRecords[s.weight] = Math.max(repRecords[s.weight] || 0, s.reps);
  });
  const seen = new Set();
  currSets.forEach(s => {
    if (s.form === 'bad' || !s.failure) return;
    const prev = repRecords[s.weight] || 0;
    const k = `${s.weight}`;
    if (s.reps > prev && prev > 0 && !seen.has(k)) {
      seen.add(k);
      prs.push({ type: 'reps', label: `Rep PR @ ${s.weight}`, value: s.reps, prev });
    }
  });

  return prs;
}

function nextSessionTargets(exerciseName, history) {
  const sessions = exerciseSessions(exerciseName, history);
  if (sessions.length < 1) return null;
  const last = sessions[sessions.length - 1];
  const working = last.sets.filter(s => s.type === 'working');
  if (!working.length) return null;

  return working.map((s, idx) => ({
    setNum: idx + 1,
    weight: s.weight,
    target: s.reps + 1,
    previous: s.reps,
  }));
}

// ============================================================
// PROGRESS RESCUE MODE
// ============================================================
// When a planned top-set progression target is missed (reps < previous session
// at the same or heavier weight), we shift the exercise into rescue mode.
// Rescue mode chases progress through alternative metrics: back-off volume,
// rep PRs at lighter weights, smaller drop-off, and optionally one extra
// back-off set if it would close the volume gap from last session.

const PAIN_REGEX = /\b(pain|painful|hurts?|hurting|sharp|tweak(ed)?|injur(y|ed)|strain(ed)?|pinch(ed)?)\b/i;
const RESCUE_MAX_WORKING_SETS = 5;
const RESCUE_STANDARD_SET_COUNT = 3;

function setHasPain(set) {
  return !!(set && set.notes && PAIN_REGEX.test(set.notes));
}

function computeRescueState(exercise, history, settings) {
  const sessions = exerciseSessions(exercise.name, history);
  const prevSession = sessions[sessions.length - 1];
  const currWorking = exercise.sets.filter(s => s.type === 'working');
  const lastWorkingSet = currWorking[currWorking.length - 1] || null;
  const currVolume = currWorking.reduce((sum, s) => sum + s.weight * s.reps, 0);

  const base = {
    active: false,
    hasPrev: false,
    workingCount: currWorking.length,
    lastWorkingSet,
    currVolume,
    prevVolume: 0,
    volumeDeficit: 0,
    triggerReason: null,
    prevTopSet: null,
  };

  if (!prevSession) return base;
  const prevWorking = prevSession.sets.filter(s => s.type === 'working');
  if (!prevWorking.length) return base;

  const prevTopSet = prevWorking.reduce((b, s) =>
    epley1RM(s.weight, s.reps) > epley1RM(b.weight, b.reps) ? s : b
  );
  const prevVolume = prevWorking.reduce((sum, s) => sum + s.weight * s.reps, 0);

  // Trigger: first working set at planned weight or heavier, but fewer reps than previous top set
  const firstWorking = currWorking[0];
  const triggered = !!firstWorking
    && firstWorking.weight >= prevTopSet.weight
    && firstWorking.reps < prevTopSet.reps;

  return {
    ...base,
    hasPrev: true,
    active: triggered,
    prevTopSet,
    prevVolume,
    volumeDeficit: prevVolume - currVolume,
    triggerReason: triggered
      ? `${firstWorking.weight}${settings.unit} produced ${firstWorking.reps} rep${firstWorking.reps !== 1 ? 's' : ''} today vs ${prevTopSet.reps} last session.`
      : null,
  };
}

function decideExtraRescueSet(rescueState, settings) {
  const last = rescueState.lastWorkingSet;
  if (!last) return null;

  // Hard set cap
  if (rescueState.workingCount >= RESCUE_MAX_WORKING_SETS) {
    return {
      tag: 'rescue-stop',
      weight: null,
      repRange: [0, 0],
      reason: `${rescueState.workingCount} working sets is the cap. Quality over quantity — recover and beat this next session.`,
      e1rm: 0,
    };
  }

  // Form failure
  if (last.form === 'bad') {
    return {
      tag: 'rescue-stop',
      weight: null,
      repRange: [0, 0],
      reason: 'Form broke down on your last set. No extra set today — clean reps matter more than rescued volume.',
      e1rm: 0,
    };
  }

  // Pain reported in notes
  if (setHasPain(last)) {
    return {
      tag: 'rescue-stop',
      weight: null,
      repRange: [0, 0],
      reason: 'You logged discomfort on the last set. No extra set — protect the joint and recover.',
      e1rm: 0,
    };
  }

  // Severe rep drop — last set fell below the rep floor
  if (last.reps < settings.targetMin) {
    return {
      tag: 'rescue-stop',
      weight: null,
      repRange: [0, 0],
      reason: `Reps dropped to ${last.reps}, below your ${settings.targetMin}-rep floor. An extra set would be junk volume.`,
      e1rm: 0,
    };
  }

  // Already matched or beat previous session's volume
  if (rescueState.volumeDeficit <= 0) {
    return {
      tag: 'rescue-stop',
      weight: null,
      repRange: [0, 0],
      reason: `You've already matched last session's volume despite the missed top set. Win banked — no need for extra work.`,
      e1rm: 0,
    };
  }

  // Recommend an extra back-off set. We emit the ideal weight; the
  // orchestrator snaps it through the loading profile (tag = rescue-extra
  // → direction = down).
  const e1rm = epley1RM(last.weight, last.reps);
  const baseWeight = weightForReps(e1rm, settings.targetIdeal);
  // Heavier fatigue cut for the 4th+ working set
  const fatigueDiscount = Math.max(0.85, 1 - 0.025 * rescueState.workingCount);
  const idealWeight = baseWeight * fatigueDiscount;

  return {
    tag: 'rescue-extra',
    weight: idealWeight,
    repRange: [settings.targetMin, settings.targetMax],
    targetReps: null,
    reason: `Volume still ${fmt(Math.round(rescueState.volumeDeficit))}${settings.unit} short of last session. One extra back-off set closes the gap and banks the win.`,
    e1rm,
  };
}

function getWorkoutRecommendation(exercise, history, settings) {
  const rescueState = computeRescueState(exercise, history, settings);
  const lastWorking = rescueState.lastWorkingSet;
  const profile = profileForExercise(exercise.name, settings);

  // No working sets yet → opening recommendation (PR push if history exists)
  if (!lastWorking) {
    const opening = recommendOpeningSet(exercise.name, history, settings);
    // Opening reuses last session's actual weight, which IS valid for the
    // profile (it was achievable last time). But we still snap defensively
    // in case the profile changed since.
    return { rec: snapRec(opening, profile, settings.unit), rescueState, profile };
  }

  // Rescue active and 3+ working sets done → check for extra set or stop signal
  if (rescueState.active && rescueState.workingCount >= RESCUE_STANDARD_SET_COUNT) {
    const decision = decideExtraRescueSet(rescueState, settings);
    if (decision) return { rec: snapRec(decision, profile, settings.unit), rescueState, profile };
  }

  // Standard adaptive recommendation
  const rec = recommendNextSet(lastWorking, exercise.sets, settings);

  // Overlay rescue framing before snapping (so the snap uses the rescue tag)
  let framedRec = rec;
  if (rescueState.active) {
    if (rescueState.workingCount === 1) {
      framedRec = {
        ...rec,
        tag: 'rescue',
        targetReps: null,
        reason: `${rescueState.triggerReason} Another heavy attempt isn't useful — chasing progress through back-off hypertrophy volume instead.`,
      };
    } else {
      framedRec = { ...rec, tag: 'rescue', targetReps: null };
    }
  }

  return { rec: snapRec(framedRec, profile, settings.unit), rescueState, profile };
}

// Snap a recommendation's ideal weight to the profile's available weights,
// using the tag to choose direction. If the profile snap reveals that the
// "ideal" target was not actually achievable, we append a brief note so
// the user understands why the displayed number isn't what the formula
// suggested in the abstract.
function snapRec(rec, profile, unit) {
  if (!rec || rec.weight === null || rec.weight === undefined) return rec;
  if (!Number.isFinite(rec.weight)) return rec;
  const idealWeight = rec.weight;
  const direction = directionForTag(rec.tag);
  const snapped = roundToAvailable(idealWeight, profile, direction);
  // If the snap moved the weight meaningfully (>0.5 unit) AND the user's
  // profile is something other than the default fixed grid, surface the
  // adjustment in the reason text.
  let reason = rec.reason;
  const moved = Math.abs(snapped - idealWeight) > 0.5;
  const profileIsCustom = profile && profile.type !== 'fixed';
  if (moved && profileIsCustom) {
    reason = `${reason} Snapped to ${fmt(snapped)}${unit || ''} — closest weight your equipment actually offers.`;
  }
  return { ...rec, weight: snapped, idealWeight, reason };
}

// ============================================================
// STORAGE
// ============================================================
// Synchronous localStorage adapter. Payload is small (a few KB even with
// hundreds of sessions) so JSON-stringify on every write is fine.
//
// Why localStorage and not IndexedDB:
// - The data model is purely tabular and non-blocking
// - Synchronous reads simplify React state hydration
// - 5MB cap is generous for years of training data
// - iOS treats both with the same eviction policy
//
// If we ever need media (videos, large blobs) or millions of records,
// migrating to IndexedDB is a one-file change.
const storage = {
  get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {
      // QuotaExceededError or private-mode failure. Surface a console
      // warning so the user can investigate via remote debugging.
      console.warn('[hypercoach] storage.set failed', key, e);
    }
  },
  del(key) {
    try { localStorage.removeItem(key); } catch {}
  },
};

// FontStyles is intentionally a no-op now. System fonts only — no Google
// Fonts CDN, no external network on first launch. The `.font-display`
// class is defined in index.css using SF Pro Display + font-stretch.
function FontStyles() {
  return null;
}

// ============================================================
// SHARED UI COMPONENTS
// ============================================================
function TopBar({ title, onBack, right, subtitle }) {
  return (
    <div className="sticky top-0 z-10 bg-neutral-950/95 backdrop-blur border-b border-neutral-800">
      <div className="flex items-center px-4 h-14">
        {onBack ? (
          <button onClick={onBack} className="-ml-2 p-2 text-neutral-400 hover:text-white">
            <ChevronLeft size={24} />
          </button>
        ) : <div className="w-2" />}
        <div className="flex-1 text-center">
          <div className="font-display text-lg uppercase tracking-wider text-white">{title}</div>
          {subtitle && <div className="text-[10px] uppercase tracking-widest text-neutral-500 -mt-0.5">{subtitle}</div>}
        </div>
        <div className="w-10 flex justify-end">{right}</div>
      </div>
    </div>
  );
}

function BottomNav({ screen, onNav, inWorkout }) {
  if (inWorkout) return null;
  const items = [
    { id: 'home', icon: HomeIcon, label: 'Home' },
    { id: 'history', icon: HistoryIcon, label: 'History' },
    { id: 'settings', icon: SettingsIcon, label: 'Settings' },
  ];
  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-10 bg-neutral-950 border-t border-neutral-800"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex max-w-md mx-auto">
        {items.map(it => {
          const active = screen === it.id;
          const Ic = it.icon;
          return (
            <button
              key={it.id}
              onClick={() => onNav(it.id)}
              className={`flex-1 flex flex-col items-center gap-1 py-3 ${active ? 'text-orange-500' : 'text-neutral-500'}`}
            >
              <Ic size={20} strokeWidth={active ? 2.5 : 2} />
              <span className="text-[10px] uppercase tracking-widest font-medium">{it.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Stepper — number input with +/− buttons that respects mobile editing.
//
// Why a string buffer? React's controlled-number-input pattern (`value={n}`,
// onChange parses) breaks free-form editing badly: clearing the field is
// awkward because the input snaps back to 0 immediately, and typing "32."
// (mid-decimal) is invisible because parseFloat("32.") === 32.
//
// Solution: while focused, hold the raw text the user typed. On blur OR
// when the parent value is changed externally (e.g. recommendation update),
// re-sync. This gives:
//   • free-form typing including decimals like "32.5"
//   • clear-to-empty without snap-back
//   • tap-to-select-all for fast overwrite
//   • +/− buttons that still always operate on the parsed numeric value
//   • a clear (×) button for one-tap reset
function Stepper({
  value, onChange,
  step, min = 0, max = 9999,
  large = false,
  allowDecimal = true,
}) {
  // Local string buffer for the *currently typed* text. null means "not
  // editing right now, mirror the parent value".
  const [draft, setDraft] = useState(null);
  const inputRef = useRef(null);

  // Re-sync when the parent value changes from outside (e.g. recommendation
  // refresh after a set is logged) and we're not actively editing.
  useEffect(() => {
    if (draft === null) {
      // mirroring; nothing to do — input displays parent value directly
    }
  }, [value, draft]);

  const display = draft !== null ? draft : fmt(value);

  const commit = (raw) => {
    if (raw === '' || raw === '-' || raw === '.') {
      // Empty or partial input on blur — keep current parent value
      setDraft(null);
      return;
    }
    let n = parseFloat(raw);
    if (!Number.isFinite(n)) {
      setDraft(null);
      return;
    }
    if (!allowDecimal) n = Math.round(n);
    n = Math.min(max, Math.max(min, n));
    onChange(parseFloat(n.toFixed(2)));
    setDraft(null);
  };

  const handleChange = (e) => {
    const v = e.target.value;
    // Allow only sane numeric characters (digits, one decimal point,
    // optional leading minus if min < 0).
    const pattern = allowDecimal
      ? /^-?\d*\.?\d*$/
      : /^-?\d*$/;
    if (v === '' || pattern.test(v)) {
      setDraft(v);
    }
  };

  const handleFocus = (e) => {
    // Defer the select() to next tick — iOS Safari needs this or it
    // collapses the selection back to the caret position.
    setTimeout(() => {
      try { e.target.select(); } catch {}
    }, 0);
  };

  const handleBlur = (e) => commit(e.target.value);
  const handleKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
    }
  };

  const dec = () => {
    // Operate on parent value, not draft — pressing − while editing should
    // step from the real current value, not whatever fragment is typed.
    onChange(Math.max(min, parseFloat((value - step).toFixed(2))));
    setDraft(null);
  };
  const inc = () => {
    onChange(Math.min(max, parseFloat((value + step).toFixed(2))));
    setDraft(null);
  };

  const showClear = draft !== null && draft !== '';

  return (
    <div className="flex items-stretch gap-1.5 w-full">
      <button
        type="button"
        onClick={dec}
        className="w-10 flex-shrink-0 bg-neutral-800 hover:bg-neutral-700 active:bg-neutral-600 rounded-lg flex items-center justify-center text-neutral-300"
        aria-label="Decrease"
      >
        <Minus size={18} strokeWidth={2.5} />
      </button>
      <div className="relative min-w-0 flex-1">
        <input
          ref={inputRef}
          type="text"
          inputMode={allowDecimal ? 'decimal' : 'numeric'}
          // Pattern hints iOS to show the dot on the numeric pad
          pattern={allowDecimal ? '[0-9]*[.,]?[0-9]*' : '[0-9]*'}
          enterKeyHint="done"
          value={display}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKey}
          autoComplete="off"
          autoCorrect="off"
          spellCheck="false"
          className={`w-full bg-neutral-900 border border-neutral-800 rounded-lg text-center text-white font-mono font-bold px-6 ${large ? 'text-2xl py-2' : 'text-lg py-1.5'} focus:outline-none focus:border-orange-500`}
        />
        {showClear && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()} // don't steal focus from input
            onClick={() => {
              setDraft('');
              inputRef.current?.focus();
            }}
            className="absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-neutral-700 hover:bg-neutral-600 text-neutral-300 flex items-center justify-center"
            aria-label="Clear"
          >
            <X size={12} strokeWidth={3} />
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={inc}
        className="w-10 flex-shrink-0 bg-neutral-800 hover:bg-neutral-700 active:bg-neutral-600 rounded-lg flex items-center justify-center text-neutral-300"
        aria-label="Increase"
      >
        <Plus size={18} strokeWidth={2.5} />
      </button>
    </div>
  );
}

function Pill({ active, onClick, children, color = 'orange' }) {
  const colors = {
    orange: active ? 'bg-orange-500 text-black border-orange-500' : 'bg-transparent text-neutral-400 border-neutral-700',
    lime: active ? 'bg-lime-500 text-black border-lime-500' : 'bg-transparent text-neutral-400 border-neutral-700',
    yellow: active ? 'bg-yellow-500 text-black border-yellow-500' : 'bg-transparent text-neutral-400 border-neutral-700',
    red: active ? 'bg-red-500 text-black border-red-500' : 'bg-transparent text-neutral-400 border-neutral-700',
  };
  return (
    <button
      onClick={onClick}
      className={`flex-1 border-2 rounded-lg py-3 text-sm font-bold uppercase tracking-wider transition-colors ${colors[color]}`}
    >
      {children}
    </button>
  );
}

function PrimaryButton({ children, onClick, disabled, className = '', icon: Icon }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full bg-orange-500 hover:bg-orange-400 active:bg-orange-600 disabled:bg-neutral-800 disabled:text-neutral-600 text-black font-bold uppercase tracking-wider py-4 rounded-lg flex items-center justify-center gap-2 transition-colors ${className}`}
    >
      {Icon && <Icon size={18} strokeWidth={2.5} />}
      {children}
    </button>
  );
}

function GhostButton({ children, onClick, icon: Icon, danger = false, className = '' }) {
  return (
    <button
      onClick={onClick}
      className={`w-full border ${danger ? 'border-red-900 text-red-400 hover:bg-red-950' : 'border-neutral-800 text-neutral-300 hover:bg-neutral-900'} font-medium uppercase tracking-wider text-sm py-3.5 rounded-lg flex items-center justify-center gap-2 transition-colors ${className}`}
    >
      {Icon && <Icon size={16} />}
      {children}
    </button>
  );
}

// ============================================================
// HOME SCREEN
// ============================================================
function HomeScreen({
  history, onStart, onOpenExercise, settings, install, online, onShowInstall,
  pausedWorkouts, onResumePaused, onDiscardPaused,
}) {
  const streak = useMemo(() => calcWeeklyStreak(history), [history]);
  // "Last workout" means most recent COMPLETED. Paused workouts surface
  // separately so we don't confuse the user about what they accomplished.
  const lastWorkout = useMemo(() => {
    const completed = history.filter(w => w.status === 'completed' || w.status === undefined);
    return completed[completed.length - 1];
  }, [history]);

  // Show install hint once per device unless dismissed. We don't pester
  // desktop users — the value of installing is much higher on phones.
  const [installDismissed, setInstallDismissed] = useState(() => {
    try { return localStorage.getItem('hypercoach:install-dismissed') === '1'; } catch { return false; }
  });
  const showInstallHint = !install.isStandalone
    && !installDismissed
    && (install.platform === 'ios' || install.platform === 'android');
  const dismissInstall = () => {
    setInstallDismissed(true);
    try { localStorage.setItem('hypercoach:install-dismissed', '1'); } catch {}
  };

  const recentExercises = useMemo(() => {
    const seen = new Set();
    const list = [];
    // Only suggest from completed sessions — paused/discarded clutter is
    // confusing.
    [...history]
      .filter(w => w.status === 'completed' || w.status === undefined)
      .reverse()
      .forEach(w => {
        w.exercises.forEach(e => {
          if (!seen.has(e.name)) {
            seen.add(e.name);
            list.push(e.name);
          }
        });
      });
    return list.slice(0, 6);
  }, [history]);

  const lastExercise = recentExercises[0];
  const targets = lastExercise ? nextSessionTargets(lastExercise, history) : null;

  const weeklyVolume = useMemo(() => {
    const weekAgo = Date.now() - 7 * 86400000;
    return history
      .filter(w => (w.status === 'completed' || w.status === undefined) && w.startedAt >= weekAgo)
      .flatMap(w => w.exercises.flatMap(e => e.sets.filter(s => s.type === 'working')))
      .reduce((sum, s) => sum + s.weight * s.reps, 0);
  }, [history]);

  return (
    <div className="pb-24 slide-up">
      {/* Hero */}
      <div className="px-5 pt-6 pb-8 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-orange-500/10 via-transparent to-transparent pointer-events-none" />
        <div className="relative">
          <div className="text-[11px] uppercase tracking-[0.3em] text-neutral-500 mb-1">Adaptive Hypertrophy</div>
          <h1 className="font-display text-5xl text-white leading-none">HYPER<span className="text-orange-500">COACH</span></h1>
        </div>
      </div>

      {showInstallHint && (
        <div className="px-5 mb-4">
          <div className="bg-gradient-to-br from-orange-500/15 to-neutral-900 border border-orange-500/30 rounded-xl p-3 flex items-center gap-3">
            <Smartphone size={20} className="text-orange-500 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs uppercase tracking-widest text-orange-400 font-bold">Install for full-screen</div>
              <div className="text-[11px] text-neutral-400 mt-0.5">Add to home screen — works fully offline.</div>
            </div>
            <button
              onClick={onShowInstall}
              className="flex-shrink-0 bg-orange-500 hover:bg-orange-400 text-black font-bold uppercase tracking-widest text-xs px-3 py-2 rounded-lg"
            >
              Install
            </button>
            <button
              onClick={dismissInstall}
              aria-label="Dismiss install hint"
              className="flex-shrink-0 text-neutral-600 hover:text-neutral-400 -mr-1 p-1"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="px-5 grid grid-cols-2 gap-3 mb-5">
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-neutral-500">
            <Flame size={12} className="text-orange-500" />
            Weekly Streak
          </div>
          <div className="font-mono font-bold text-3xl text-white mt-1">
            {streak}<span className="text-base text-neutral-500">w</span>
          </div>
        </div>
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-neutral-500">
            <BarChart3 size={12} className="text-orange-500" />
            7d Volume
          </div>
          <div className="font-mono font-bold text-3xl text-white mt-1">
            {fmt(Math.round(weeklyVolume))}<span className="text-base text-neutral-500">{settings.unit}</span>
          </div>
        </div>
      </div>

      {/* Resume paused workout(s) */}
      {pausedWorkouts && pausedWorkouts.length > 0 && (
        <div className="px-5 mb-6">
          <div className="text-[10px] uppercase tracking-widest text-amber-400 mb-2 px-1 flex items-center gap-1.5">
            <Pause size={11} /> Paused — Resume Workout
          </div>
          <div className="space-y-2">
            {pausedWorkouts.map(pw => {
              const setCount = pw.exercises.reduce(
                (s, e) => s + e.sets.filter(x => x.type === 'working').length, 0
              );
              return (
                <div key={pw.id} className="bg-gradient-to-br from-amber-500/10 to-neutral-900 border border-amber-500/30 rounded-xl p-3 flex items-center gap-3">
                  <button
                    onClick={() => onResumePaused(pw.id)}
                    className="flex-1 flex items-center gap-3 text-left min-w-0"
                  >
                    <PlayCircle size={28} className="text-amber-400 flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm text-white truncate">
                        {pw.exercises.map(e => e.name).join(' · ') || 'Empty workout'}
                      </div>
                      <div className="text-[10px] uppercase tracking-widest text-neutral-500 mt-0.5">
                        Paused {fmtRelativeDate(pw.startedAt)} · {setCount} sets logged
                      </div>
                    </div>
                  </button>
                  <button
                    onClick={() => onDiscardPaused(pw.id)}
                    aria-label="Discard paused workout"
                    className="flex-shrink-0 text-neutral-600 hover:text-red-400 p-2"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Start CTA */}
      <div className="px-5 mb-6">
        <button
          onClick={onStart}
          className="w-full bg-orange-500 hover:bg-orange-400 text-black font-display text-2xl uppercase tracking-wider py-5 rounded-xl flex items-center justify-center gap-3 pulse-ring"
        >
          <Play size={22} fill="currentColor" />
          Start Workout
        </button>
      </div>

      {/* Last workout */}
      {lastWorkout && (
        <div className="px-5 mb-6">
          <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-2 px-1">Last Workout</div>
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs text-neutral-400">{fmtRelativeDate(lastWorkout.startedAt)}</div>
              <div className="text-xs font-mono text-orange-500">
                {lastWorkout.exercises.reduce((s, e) => s + e.sets.filter(x => x.type === 'working').length, 0)} sets
              </div>
            </div>
            <div className="space-y-1.5">
              {lastWorkout.exercises.map((e, i) => {
                const work = e.sets.filter(s => s.type === 'working');
                const top = work.length
                  ? work.reduce((b, s) => epley1RM(s.weight, s.reps) > epley1RM(b.weight, b.reps) ? s : b)
                  : null;
                return top ? (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <span className="text-neutral-200 truncate pr-2">{e.name}</span>
                    <span className="font-mono text-neutral-500 text-xs whitespace-nowrap">
                      {top.weight}{settings.unit} × {top.reps}
                    </span>
                  </div>
                ) : null;
              })}
            </div>
          </div>
        </div>
      )}

      {/* Next progression target */}
      {targets && lastExercise && (
        <div className="px-5 mb-6">
          <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-2 px-1">Next Time on {lastExercise}</div>
          <div className="bg-neutral-900 border-l-2 border-orange-500 border-y border-r border-y-neutral-800 border-r-neutral-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3 text-orange-500">
              <Target size={14} />
              <span className="text-xs uppercase tracking-widest font-bold">Progression Targets</span>
            </div>
            <div className="space-y-2">
              {targets.map(t => (
                <div key={t.setNum} className="flex items-center justify-between">
                  <span className="text-xs text-neutral-500">Set {t.setNum}</span>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-mono text-neutral-400">{t.weight}{settings.unit}</span>
                    <span className="text-neutral-600">×</span>
                    <span className="font-mono text-neutral-500 line-through text-xs">{t.previous}</span>
                    <ArrowRight size={12} className="text-orange-500" />
                    <span className="font-mono font-bold text-orange-500">{t.target}+</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Recent exercises */}
      {recentExercises.length > 0 && (
        <div className="mb-6">
          <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-2 px-6">Recent Exercises</div>
          <div className="px-5 grid grid-cols-2 gap-2">
            {recentExercises.map(name => (
              <button
                key={name}
                onClick={() => onOpenExercise(name)}
                className="bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 rounded-lg p-3 text-left"
              >
                <div className="text-sm text-white truncate">{name}</div>
                <div className="text-[10px] uppercase tracking-widest text-neutral-500 mt-0.5">
                  e1RM {fmt(Math.round(bestE1RM(name, history)))}{settings.unit}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {!history.length && (
        <div className="px-5 py-12 text-center">
          <Dumbbell size={40} className="mx-auto text-neutral-700 mb-3" />
          <div className="text-neutral-500 text-sm">No workouts yet. Hit Start Workout to begin.</div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// EXERCISE SELECT SCREEN
// ============================================================
function ExerciseSelectScreen({ history, onSelect, onBack }) {
  const [query, setQuery] = useState('');
  const [customName, setCustomName] = useState('');

  const userExercises = useMemo(() => {
    const set = new Set();
    history.forEach(w => w.exercises.forEach(e => set.add(e.name)));
    return Array.from(set);
  }, [history]);

  const allExercises = useMemo(() => {
    const map = new Map();
    COMMON_EXERCISES.forEach(e => map.set(e.name, e));
    userExercises.forEach(name => {
      if (!map.has(name)) map.set(name, { name, group: 'Custom' });
    });
    return Array.from(map.values());
  }, [userExercises]);

  const filtered = useMemo(() => {
    if (!query.trim()) return allExercises;
    const q = query.toLowerCase();
    return allExercises.filter(e => e.name.toLowerCase().includes(q));
  }, [query, allExercises]);

  const grouped = useMemo(() => {
    const g = {};
    filtered.forEach(e => {
      if (!g[e.group]) g[e.group] = [];
      g[e.group].push(e);
    });
    return g;
  }, [filtered]);

  const showCustomOption = query.trim() && !filtered.some(e => e.name.toLowerCase() === query.toLowerCase());

  return (
    <div className="pb-6 slide-up">
      <TopBar title="Pick Exercise" onBack={onBack} />
      <div className="p-4 sticky top-14 bg-neutral-950 z-10">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search or type custom..."
            className="w-full bg-neutral-900 border border-neutral-800 rounded-lg pl-10 pr-3 py-3 text-white placeholder:text-neutral-600 focus:outline-none focus:border-orange-500"
          />
        </div>
      </div>

      {showCustomOption && (
        <div className="px-4 pb-3">
          <button
            onClick={() => onSelect(query.trim())}
            className="w-full border-2 border-dashed border-orange-500/40 hover:border-orange-500 rounded-lg p-4 text-left flex items-center gap-3"
          >
            <Plus size={18} className="text-orange-500" />
            <div>
              <div className="text-[10px] uppercase tracking-widest text-orange-500">Add custom</div>
              <div className="text-white">{query.trim()}</div>
            </div>
          </button>
        </div>
      )}

      <div className="px-4">
        {Object.entries(grouped).map(([group, exs]) => (
          <div key={group} className="mb-5">
            <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-2 px-1">{group}</div>
            <div className="space-y-1.5">
              {exs.map(e => {
                const last = history.flatMap(w => w.exercises.filter(x => x.name === e.name).map(x => ({ ...x, when: w.startedAt }))).sort((a, b) => b.when - a.when)[0];
                return (
                  <button
                    key={e.name}
                    onClick={() => onSelect(e.name)}
                    className="w-full bg-neutral-900 hover:bg-neutral-800 active:bg-neutral-700 border border-neutral-800 rounded-lg p-3.5 text-left flex items-center justify-between"
                  >
                    <span className="text-white">{e.name}</span>
                    {last && (
                      <span className="text-[10px] font-mono text-neutral-500 uppercase tracking-wider">
                        {fmtRelativeDate(last.when)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// RECOMMENDATION CARD
// ============================================================
function RecommendationCard({ rec, settings }) {
  const tagColors = {
    'too-heavy': 'border-red-500/60',
    'reset': 'border-red-500/60',
    'adjust': 'border-yellow-500/60',
    'on-track': 'border-orange-500',
    'push': 'border-lime-500/70',
    'progress': 'border-lime-500/70',
    'calibrate': 'border-neutral-600',
    'warmup': 'border-neutral-600',
    'rescue': 'border-violet-500',
    'rescue-extra': 'border-violet-500',
    'rescue-stop': 'border-amber-500/70',
  };
  const tagAccents = {
    'too-heavy': 'text-red-400',
    'reset': 'text-red-400',
    'adjust': 'text-yellow-400',
    'on-track': 'text-orange-500',
    'push': 'text-lime-400',
    'progress': 'text-lime-400',
    'calibrate': 'text-neutral-400',
    'warmup': 'text-neutral-300',
    'rescue': 'text-violet-400',
    'rescue-extra': 'text-violet-400',
    'rescue-stop': 'text-amber-400',
  };
  const tagLabels = {
    'too-heavy': 'Drop Load',
    'reset': 'Reset',
    'adjust': 'Adjust',
    'on-track': 'On Target',
    'push': 'Push',
    'progress': 'Progress',
    'calibrate': 'Calibrate',
    'warmup': 'Warm-up',
    'rescue': 'Rescue Mode',
    'rescue-extra': 'Bonus Set · Rescue',
    'rescue-stop': 'Recover · Rescue Mode',
  };
  const border = tagColors[rec.tag] || 'border-orange-500';
  const accent = tagAccents[rec.tag] || 'text-orange-500';
  const isWarmup = rec.tag === 'warmup';
  const isRescue = rec.tag === 'rescue' || rec.tag === 'rescue-extra';
  const isRescueStop = rec.tag === 'rescue-stop';

  // Rescue-stop has its own layout — no weight × reps numbers, just guidance
  if (isRescueStop) {
    return (
      <div className={`bg-neutral-900 border-l-4 ${border} border-y border-r border-y-neutral-800 border-r-neutral-800 rounded-xl p-5`}>
        <div className={`flex items-center gap-2 ${accent} mb-3`}>
          <Shield size={14} />
          <span className="text-[10px] uppercase tracking-widest font-bold">{tagLabels[rec.tag]}</span>
        </div>
        <div className="font-display text-3xl text-white uppercase mb-3 leading-none">Stop Here</div>
        <div className="text-sm text-neutral-300 leading-relaxed">{rec.reason}</div>
        <div className="text-xs text-neutral-500 mt-4 pt-3 border-t border-neutral-800">
          Today's win is recovery. Hit Finish Workout when ready — you can override below if you must.
        </div>
      </div>
    );
  }

  const headerLabel = isWarmup
    ? 'Warm-up Set'
    : isRescue
      ? tagLabels[rec.tag]
      : `Next Set · ${tagLabels[rec.tag] || 'Recommended'}`;
  const HeaderIcon = isWarmup ? Activity : isRescue ? LifeBuoy : Target;

  return (
    <div className={`bg-neutral-900 border-l-4 ${border} border-y border-r border-y-neutral-800 border-r-neutral-800 rounded-xl p-5`}>
      <div className="flex items-center justify-between mb-3">
        <div className={`flex items-center gap-2 ${accent}`}>
          <HeaderIcon size={14} />
          <span className="text-[10px] uppercase tracking-widest font-bold">{headerLabel}</span>
        </div>
        {rec.e1rm > 0 && (
          <div className="text-[10px] uppercase tracking-widest text-neutral-500 font-mono">
            e1RM {fmt(Math.round(rec.e1rm))}{settings.unit}
          </div>
        )}
      </div>

      <div className="flex items-baseline gap-3 mb-3">
        {rec.weight !== null ? (
          <>
            <div className="font-mono font-bold text-5xl text-white">
              {fmt(rec.weight)}<span className={`text-2xl ${accent}`}>{settings.unit}</span>
            </div>
            <div className="text-neutral-500 font-mono text-2xl">×</div>
            <div className="font-mono font-bold text-3xl text-white">
              {(isWarmup || isRescue)
                ? `${rec.repRange[0]}–${rec.repRange[1]}`
                : (rec.targetReps ? `${rec.targetReps}+` : `${rec.repRange[0]}–${rec.repRange[1]}`)
              }
            </div>
          </>
        ) : (
          <div className="text-neutral-400 text-lg italic">Pick a calibration weight</div>
        )}
      </div>

      {!isWarmup && !isRescue && (
        <div className="text-xs text-neutral-500 uppercase tracking-widest mb-1">Range {rec.repRange[0]}–{rec.repRange[1]}</div>
      )}

      <div className="text-sm text-neutral-300 leading-relaxed border-t border-neutral-800 pt-3 mt-3">
        {rec.reason}
      </div>
    </div>
  );
}

// ============================================================
// LIVE WORKOUT SCREEN
// ============================================================
function WorkoutScreen({
  workout, activeExerciseIdx, history, settings,
  onLogSet, onDeleteSet, onAddExercise, onFinishExercise, onFinishWorkout, onDiscardWorkout, onBack,
}) {
  const exercise = workout.exercises[activeExerciseIdx];

  // Single source of truth for what to recommend next.
  // Handles: opening set, fatigue/form-driven adjustment, rescue mode framing,
  // extra rescue set evaluation, and rescue-stop signaling.
  const { rec: workingRec, rescueState } = useMemo(
    () => getWorkoutRecommendation(exercise, history, settings),
    [exercise, history, settings]
  );
  const lastWorkingSet = rescueState.lastWorkingSet;

  // Warm-up: 50% of planned working weight × 5–8 reps.
  // Only suggested when (a) we have a known working weight from previous history
  // and (b) no working sets have been logged yet this exercise.
  const warmupRec = useMemo(() => {
    if (!workingRec || workingRec.weight === null) return null;
    if (lastWorkingSet) return null;
    const profile = profileForExercise(exercise.name, settings);
    // Snap warmup DOWN — never warm up with more weight than the formula
    // suggested, even if rounding could go either way.
    const w = roundToAvailable(workingRec.weight * 0.5, profile, 'down');
    return {
      weight: w,
      repRange: [5, 8],
      targetReps: 5,
      reason: `Half of today's planned working weight (${workingRec.weight}${settings.unit}). Primes the movement without eating into your working set strength.`,
      e1rm: 0,
      tag: 'warmup',
    };
  }, [workingRec, lastWorkingSet, settings, exercise.name]);

  const warmupAvailable = !!warmupRec;
  const isRescueStop = workingRec.tag === 'rescue-stop';

  // Local input state
  const [setType, setSetType] = useState('working');
  const [weight, setWeight] = useState(workingRec.weight ?? 20);
  const [reps, setReps] = useState(workingRec.targetReps ?? 8);
  const [failure, setFailure] = useState(true);
  const [form, setForm] = useState('good');
  const [notes, setNotes] = useState('');
  const [showNotes, setShowNotes] = useState(false);

  // If warm-up tab becomes unavailable while user is on it, switch to working
  useEffect(() => {
    if (setType === 'warmup' && !warmupAvailable) setSetType('working');
  }, [setType, warmupAvailable]);

  // The active recommendation depends on which set type the user is logging
  const recommendation = setType === 'warmup' && warmupRec ? warmupRec : workingRec;

  // Reset inputs when set count changes (after logging) or when user switches tab
  const lastRecKey = `${exercise.name}:${exercise.sets.length}:${setType}`;
  const seenRecKey = useRef(null);
  useEffect(() => {
    if (seenRecKey.current !== lastRecKey) {
      seenRecKey.current = lastRecKey;
      if (recommendation.weight !== null) setWeight(recommendation.weight);
      if (recommendation.targetReps) setReps(recommendation.targetReps);
      // After logging any set, default back to working (warm-up is one-and-done before working sets)
      if (exercise.sets.length > 0 && setType === 'warmup') setSetType('working');
      setFailure(setType !== 'warmup');
      setForm('good');
      setNotes('');
      setShowNotes(false);
    }
  }, [lastRecKey, recommendation, exercise.sets.length, setType]);

  const handleSave = () => {
    // Commit any in-flight input edits before reading state. Tapping Save
    // while a Stepper input still has draft text means React hasn't yet
    // received the blur event — force it so the draft becomes the parent
    // value before we read `weight` and `reps`.
    if (typeof document !== 'undefined' && document.activeElement?.blur) {
      document.activeElement.blur();
    }
    // Defer one tick so state updates from blur land first.
    setTimeout(() => {
      if (weight <= 0 || reps <= 0) return;
      onLogSet({
        weight,
        reps,
        failure: setType === 'warmup' ? false : failure,
        form: setType === 'warmup' ? 'good' : form,
        type: setType,
        notes: notes.trim() || undefined,
        timestamp: Date.now(),
      });
    }, 0);
  };

  const previousSession = useMemo(() => {
    const past = exerciseSessions(exercise.name, history);
    return past[past.length - 1];
  }, [exercise.name, history]);

  return (
    <div className="pb-32 slide-up">
      <TopBar
        title={exercise.name}
        onBack={onBack}
        subtitle={`Exercise ${activeExerciseIdx + 1} · ${exercise.sets.length} ${exercise.sets.length === 1 ? 'set' : 'sets'} logged`}
        right={
          <button onClick={onFinishWorkout} className="text-[10px] uppercase tracking-widest text-orange-500 font-bold px-2">
            Finish
          </button>
        }
      />

      {/* Previous session reference */}
      {previousSession && previousSession.sets.length > 0 && (
        <div className="px-4 pt-4">
          <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5 px-1">
            Previous · {fmtRelativeDate(previousSession.when)}
          </div>
          <div className="bg-neutral-900/60 border border-neutral-800 rounded-lg px-3 py-2 flex gap-3 overflow-x-auto scrollbar-hide">
            {previousSession.sets.map((s, i) => (
              <div key={i} className="flex-shrink-0 text-center">
                <div className="font-mono text-sm text-neutral-300">{s.weight}<span className="text-neutral-500 text-xs">{settings.unit}</span></div>
                <div className="font-mono text-xs text-neutral-500">×{s.reps}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recommendation */}
      <div className="px-4 pt-4">
        {rescueState.active && setType === 'working' && workingRec.tag !== 'rescue-stop' && (
          <div className="flex items-center gap-2 mb-2 px-3 py-2 bg-violet-500/10 border border-violet-500/30 rounded-lg">
            <LifeBuoy size={14} className="text-violet-400 flex-shrink-0" />
            <div className="text-[11px] text-violet-300 leading-tight">
              <span className="font-bold uppercase tracking-widest">Progress Rescue Mode</span>
              <span className="text-violet-400/70 ml-1.5">· chasing volume, not PRs today</span>
            </div>
          </div>
        )}
        <RecommendationCard rec={recommendation} settings={settings} />
        {rescueState.active && rescueState.hasPrev && rescueState.workingCount >= 1 && setType === 'working' && !isRescueStop && (
          <div className="mt-2 px-3 py-2 flex items-center justify-between text-[11px]">
            <span className="text-neutral-500 uppercase tracking-widest">Volume vs last session</span>
            <span className={`font-mono font-bold ${rescueState.volumeDeficit > 0 ? 'text-amber-400' : 'text-lime-400'}`}>
              {rescueState.volumeDeficit > 0
                ? `−${fmt(Math.round(rescueState.volumeDeficit))}${settings.unit}`
                : `+${fmt(Math.round(-rescueState.volumeDeficit))}${settings.unit}`}
            </span>
          </div>
        )}
      </div>

      {/* Sets logged this exercise */}
      {exercise.sets.length > 0 && (
        <div className="px-4 pt-5">
          <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-2 px-1">Logged Sets</div>
          <div className="space-y-1.5">
            {exercise.sets.map((s, i) => {
              const isWarmup = s.type === 'warmup';
              const setLabel = isWarmup
                ? 'Warm'
                : `Set ${exercise.sets.slice(0, i + 1).filter(x => x.type === 'working').length}`;
              return (
                <div key={i} className="bg-neutral-900 border border-neutral-800 rounded-lg pl-3 pr-1.5 py-2 flex items-center gap-3">
                  <div className="text-[10px] uppercase tracking-widest text-neutral-500 w-12 font-bold flex-shrink-0">
                    {setLabel}
                  </div>
                  <div className="flex-1 font-mono min-w-0">
                    <span className="text-white font-bold">{s.weight}{settings.unit}</span>
                    <span className="text-neutral-600 mx-2">×</span>
                    <span className="text-white font-bold">{s.reps}</span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {!isWarmup && s.failure && <span className="text-[9px] uppercase tracking-widest text-red-400 font-bold">F</span>}
                    {!isWarmup && (
                      <span className={`text-[9px] uppercase tracking-widest font-bold ${
                        s.form === 'good' ? 'text-lime-400' : s.form === 'okay' ? 'text-yellow-400' : 'text-red-400'
                      }`}>{s.form[0]}</span>
                    )}
                  </div>
                  <button
                    onClick={() => onDeleteSet(i)}
                    aria-label={`Delete ${setLabel}`}
                    className="flex-shrink-0 p-2 text-neutral-600 hover:text-red-400 active:text-red-500"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Input section */}
      <div className="px-4 pt-6">
        <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-3 px-1">Log Your Set</div>

        {/* Set type tabs — only shown if a warm-up is available */}
        {warmupAvailable && (
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => setSetType('warmup')}
              className={`flex-1 py-2 rounded-lg text-xs uppercase tracking-widest font-bold border ${setType === 'warmup' ? 'bg-neutral-700 text-white border-neutral-600' : 'bg-transparent text-neutral-500 border-neutral-800'}`}
            >Warm-up</button>
            <button
              onClick={() => setSetType('working')}
              className={`flex-1 py-2 rounded-lg text-xs uppercase tracking-widest font-bold border ${setType === 'working' ? 'bg-orange-500 text-black border-orange-500' : 'bg-transparent text-neutral-500 border-neutral-800'}`}
            >Working Set</button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5 px-1">Weight ({settings.unit})</div>
            <Stepper value={weight} onChange={setWeight} step={settings.increment} min={0} max={9999} large />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5 px-1">Reps</div>
            <Stepper value={reps} onChange={v => setReps(Math.round(v))} step={1} min={1} max={100} large allowDecimal={false} />
          </div>
        </div>

        {setType === 'working' && (
          <>
            <div className="mb-3">
              <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5 px-1">To Failure?</div>
              <div className="flex gap-2">
                <Pill active={failure} onClick={() => setFailure(true)} color="orange">Yes</Pill>
                <Pill active={!failure} onClick={() => setFailure(false)} color="orange">No</Pill>
              </div>
            </div>

            <div className="mb-3">
              <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5 px-1">Form Quality</div>
              <div className="flex gap-2">
                <Pill active={form === 'good'} onClick={() => setForm('good')} color="lime">Good</Pill>
                <Pill active={form === 'okay'} onClick={() => setForm('okay')} color="yellow">Okay</Pill>
                <Pill active={form === 'bad'} onClick={() => setForm('bad')} color="red">Bad</Pill>
              </div>
            </div>
          </>
        )}

        {setType === 'warmup' && (
          <div className="mb-3 px-3 py-2.5 bg-neutral-900/50 border border-neutral-800 rounded-lg flex items-start gap-2">
            <Info size={14} className="text-neutral-500 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-neutral-400 leading-relaxed">
              Warm-ups are logged as-is — they don't drive the next-set formula or count toward fatigue, PRs, or volume.
            </div>
          </div>
        )}

        <button
          onClick={() => setShowNotes(!showNotes)}
          className="text-xs text-neutral-500 hover:text-neutral-300 flex items-center gap-1.5 mb-2"
        >
          <Edit3 size={12} />
          {showNotes ? 'Hide notes' : 'Add notes (optional)'}
        </button>
        {showNotes && (
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="e.g. left shoulder twinge, pause reps..."
            rows={2}
            className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-orange-500 mb-3"
          />
        )}

        {isRescueStop ? (
          <>
            <button
              onClick={onFinishWorkout}
              className="w-full bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-black font-bold uppercase tracking-wider py-4 rounded-lg flex items-center justify-center gap-2 mb-2"
            >
              <Shield size={18} strokeWidth={2.5} />
              Finish Workout
            </button>
            <button
              onClick={handleSave}
              className="w-full text-xs text-neutral-500 hover:text-neutral-300 py-2 mb-3"
            >
              Override and log this set anyway
            </button>
          </>
        ) : (
          <PrimaryButton onClick={handleSave} icon={Save} className="mb-3">
            Save Set
          </PrimaryButton>
        )}

        <div className="grid grid-cols-2 gap-2">
          <GhostButton onClick={onAddExercise} icon={Plus}>
            Add Exercise
          </GhostButton>
          <GhostButton onClick={onFinishWorkout} icon={Square}>
            Finish Workout
          </GhostButton>
        </div>
        <button
          onClick={onDiscardWorkout}
          className="w-full mt-2 text-xs text-neutral-600 hover:text-red-400 py-2"
        >
          Discard workout
        </button>
      </div>
    </div>
  );
}

// ============================================================
// SUMMARY SCREEN
// ============================================================
function SummaryScreen({ workout, history, settings, onDone }) {
  // history here is BEFORE this workout was added
  const workingOnly = (sets) => sets.filter(s => s.type === 'working');
  const totalVolume = workout.exercises
    .flatMap(e => workingOnly(e.sets))
    .reduce((s, x) => s + x.weight * x.reps, 0);
  const totalSets = workout.exercises.reduce((s, e) => s + workingOnly(e.sets).length, 0);
  const totalWarmups = workout.exercises.reduce((s, e) => s + e.sets.filter(x => x.type === 'warmup').length, 0);
  const duration = Math.round((Date.now() - workout.startedAt) / 60000);

  const exerciseSummaries = workout.exercises.map(ex => {
    const prs = detectExercisePRs(ex, history);
    const work = workingOnly(ex.sets);
    const top = work.length
      ? work.reduce((b, s) => epley1RM(s.weight, s.reps) > epley1RM(b.weight, b.reps) ? s : b)
      : null;
    const prevBest = bestE1RM(ex.name, history);
    const currBest = work.reduce((m, s) => Math.max(m, epley1RM(s.weight, s.reps)), 0);
    const delta = currBest - prevBest;

    // Rescue trigger detection — was rescue mode active for this exercise during the workout?
    const rescueState = computeRescueState(ex, history, settings);

    // Volume win — current vs previous session, useful even when no PR was set
    const prevSession = exerciseSessions(ex.name, history).slice(-1)[0];
    const prevVolume = prevSession
      ? prevSession.sets.filter(s => s.type === 'working').reduce((sum, s) => sum + s.weight * s.reps, 0)
      : 0;
    const currVolume = work.reduce((sum, s) => sum + s.weight * s.reps, 0);
    const volumeWin = prevVolume > 0 && currVolume > prevVolume
      ? { delta: currVolume - prevVolume, prev: prevVolume, curr: currVolume }
      : null;

    return { ex, prs, top, currBest, prevBest, delta, workingCount: work.length, rescueState, volumeWin };
  });

  const allPRs = exerciseSummaries.flatMap(s => s.prs.map(pr => ({ ...pr, exercise: s.ex.name })));

  return (
    <div className="pb-24 slide-up">
      <TopBar title="Workout Complete" />

      <div className="px-5 pt-6 text-center">
        <CheckCircle2 size={48} className="mx-auto text-orange-500 mb-3" />
        <div className="font-display text-4xl text-white uppercase">Done.</div>
        <div className="text-neutral-500 text-sm mt-1">{new Date(workout.startedAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</div>
      </div>

      <div className="px-4 pt-6 grid grid-cols-3 gap-2">
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3 text-center">
          <div className="text-[10px] uppercase tracking-widest text-neutral-500">Volume</div>
          <div className="font-mono font-bold text-xl text-white mt-1">{fmt(Math.round(totalVolume))}<span className="text-xs text-neutral-500">{settings.unit}</span></div>
        </div>
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3 text-center">
          <div className="text-[10px] uppercase tracking-widest text-neutral-500">Working Sets</div>
          <div className="font-mono font-bold text-xl text-white mt-1">{totalSets}{totalWarmups > 0 && <span className="text-xs text-neutral-500"> +{totalWarmups}w</span>}</div>
        </div>
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3 text-center">
          <div className="text-[10px] uppercase tracking-widest text-neutral-500">Time</div>
          <div className="font-mono font-bold text-xl text-white mt-1">{duration}<span className="text-xs text-neutral-500">m</span></div>
        </div>
      </div>

      {allPRs.length > 0 && (
        <div className="px-4 pt-6">
          <div className="text-[10px] uppercase tracking-widest text-lime-400 mb-2 px-1 flex items-center gap-1">
            <Trophy size={12} /> Personal Records
          </div>
          <div className="bg-gradient-to-br from-lime-950/40 to-neutral-900 border border-lime-500/30 rounded-xl p-4 space-y-2">
            {allPRs.map((pr, i) => (
              <div key={i} className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-white font-medium">{pr.exercise}</div>
                  <div className="text-[10px] uppercase tracking-widest text-lime-400">{pr.label}</div>
                </div>
                <div className="text-right font-mono">
                  <div className="text-lime-400 font-bold">{fmt(Math.round(pr.value * 10) / 10)}</div>
                  <div className="text-[10px] text-neutral-500">prev {fmt(Math.round(pr.prev * 10) / 10)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="px-4 pt-6">
        <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-2 px-1">Exercises</div>
        <div className="space-y-3">
          {exerciseSummaries.map(({ ex, top, currBest, prevBest, delta, workingCount, rescueState, volumeWin }) => (
            <div key={ex.name} className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2 gap-2">
                <div className="text-white font-medium truncate">{ex.name}</div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {rescueState.active && (
                    <span className="text-[9px] uppercase tracking-widest font-bold text-violet-400 bg-violet-500/10 border border-violet-500/30 rounded px-1.5 py-0.5 flex items-center gap-1">
                      <LifeBuoy size={9} /> Rescue
                    </span>
                  )}
                  <div className="text-[10px] uppercase tracking-widest text-neutral-500">{workingCount} working set{workingCount !== 1 ? 's' : ''}</div>
                </div>
              </div>
              {top && (
                <div className="flex items-center justify-between text-sm">
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-neutral-500">Best Set</div>
                    <div className="font-mono text-white">{top.weight}{settings.unit} × {top.reps}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-widest text-neutral-500">e1RM</div>
                    <div className="font-mono text-white">
                      {fmt(Math.round(currBest))}{settings.unit}
                      {prevBest > 0 && delta !== 0 && (
                        <span className={`ml-2 text-xs ${delta > 0 ? 'text-lime-400' : 'text-red-400'}`}>
                          {delta > 0 ? '+' : ''}{fmt(Math.round(delta * 10) / 10)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {volumeWin && (
                <div className="mt-2 pt-2 border-t border-neutral-800 flex items-center justify-between text-xs">
                  <span className="text-neutral-500 uppercase tracking-widest">Volume Win</span>
                  <span className="font-mono text-lime-400">+{fmt(Math.round(volumeWin.delta))}{settings.unit}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Next time targets */}
      <div className="px-4 pt-6">
        <div className="text-[10px] uppercase tracking-widest text-orange-500 mb-2 px-1 flex items-center gap-1">
          <Target size={12} /> Aim For Next Time
        </div>
        <div className="bg-neutral-900 border-l-2 border-orange-500 border-y border-r border-y-neutral-800 border-r-neutral-800 rounded-xl p-4 space-y-2">
          {workout.exercises.map(ex => {
            const work = ex.sets.filter(s => s.type === 'working');
            if (!work.length) return null;
            const top = work.reduce((b, s) => epley1RM(s.weight, s.reps) > epley1RM(b.weight, b.reps) ? s : b);
            return (
              <div key={ex.name} className="flex items-center justify-between text-sm">
                <span className="text-neutral-300 truncate pr-2">{ex.name}</span>
                <span className="font-mono text-orange-500 whitespace-nowrap">
                  {top.weight}{settings.unit} × {top.reps + 1}+
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="px-4 pt-6">
        <PrimaryButton onClick={onDone}>Done</PrimaryButton>
      </div>
    </div>
  );
}

// ============================================================
// HISTORY SCREEN
// ============================================================
function HistoryScreen({ history, settings, onDeleteWorkout, onEditWorkout }) {
  const [selectedExercise, setSelectedExercise] = useState(null);

  const allExerciseNames = useMemo(() => {
    const set = new Set();
    history.forEach(w => w.exercises.forEach(e => set.add(e.name)));
    return Array.from(set).sort();
  }, [history]);

  if (selectedExercise) {
    return <ExerciseDetailScreen
      name={selectedExercise}
      history={history}
      settings={settings}
      onBack={() => setSelectedExercise(null)}
    />;
  }

  return (
    <div className="pb-24 slide-up">
      <TopBar title="History" />
      {history.length === 0 ? (
        <div className="px-5 py-12 text-center">
          <HistoryIcon size={40} className="mx-auto text-neutral-700 mb-3" />
          <div className="text-neutral-500 text-sm">No workouts logged yet.</div>
        </div>
      ) : (
        <div className="px-4 pt-4">
          <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-2 px-1">Exercises</div>
          <div className="space-y-1.5 mb-6">
            {allExerciseNames.map(name => {
              const sessions = exerciseSessions(name, history);
              const best = bestE1RM(name, history);
              return (
                <button
                  key={name}
                  onClick={() => setSelectedExercise(name)}
                  className="w-full bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 rounded-lg p-3.5 text-left flex items-center justify-between"
                >
                  <div>
                    <div className="text-white">{name}</div>
                    <div className="text-[10px] uppercase tracking-widest text-neutral-500 mt-0.5">
                      {sessions.length} session{sessions.length !== 1 ? 's' : ''}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm text-orange-500">{fmt(Math.round(best))}{settings.unit}</div>
                    <div className="text-[10px] uppercase tracking-widest text-neutral-500">e1RM</div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-2 px-1">Sessions</div>
          <div className="space-y-2">
            {[...history]
              .filter(w => w.status === 'completed' || w.status === undefined)
              .reverse()
              .map(w => {
                const workingSets = w.exercises.flatMap(e => e.sets.filter(s => s.type === 'working'));
                const totalSets = workingSets.length;
                const totalVol = workingSets.reduce((s, x) => s + x.weight * x.reps, 0);
                return (
                  <div key={w.id} className="bg-neutral-900 border border-neutral-800 rounded-lg p-3 flex items-stretch gap-2">
                    <button
                      onClick={() => onEditWorkout(w)}
                      className="flex-1 min-w-0 text-left"
                    >
                      <div className="flex items-center gap-2 mb-1.5">
                        <div className="text-sm text-white">{new Date(w.startedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
                        {w.edited && (
                          <span className="text-[9px] uppercase tracking-widest text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5 font-bold">
                            Edited
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-neutral-400 truncate">
                        {w.exercises.map(e => e.name).join(' · ')}
                      </div>
                      <div className="text-[10px] uppercase tracking-widest font-mono text-neutral-500 mt-1">
                        {totalSets} sets · {fmt(Math.round(totalVol))}{settings.unit}
                      </div>
                    </button>
                    <div className="flex flex-col gap-1">
                      <button
                        onClick={() => onEditWorkout(w)}
                        aria-label="Edit workout"
                        className="p-1.5 text-neutral-500 hover:text-orange-400"
                      >
                        <Edit3 size={14} />
                      </button>
                      <button
                        onClick={() => onDeleteWorkout(w)}
                        aria-label="Delete workout"
                        className="p-1.5 text-neutral-600 hover:text-red-400"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}

function ExerciseDetailScreen({ name, history, settings, onBack }) {
  const sessions = exerciseSessions(name, history);
  const best1RM = bestE1RM(name, history);
  const allWorkingSets = sessions.flatMap(s => s.sets.filter(x => x.type === 'working'));
  const best = allWorkingSets.reduce((b, s) => !b || s.weight > b.weight ? s : b, null);
  const totalVolume = allWorkingSets.reduce((sum, s) => sum + s.weight * s.reps, 0);

  // Best reps at each weight (working only)
  const bestRepsByWeight = {};
  allWorkingSets.forEach(s => {
    bestRepsByWeight[s.weight] = Math.max(bestRepsByWeight[s.weight] || 0, s.reps);
  });
  const weightKeys = Object.keys(bestRepsByWeight).map(Number).sort((a, b) => b - a).slice(0, 6);

  return (
    <div className="pb-24 slide-up">
      <TopBar title={name} onBack={onBack} subtitle={`${sessions.length} sessions`} />

      <div className="px-4 pt-4 grid grid-cols-3 gap-2">
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3">
          <div className="text-[10px] uppercase tracking-widest text-neutral-500">Best e1RM</div>
          <div className="font-mono font-bold text-xl text-orange-500 mt-1">{fmt(Math.round(best1RM))}<span className="text-xs">{settings.unit}</span></div>
        </div>
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3">
          <div className="text-[10px] uppercase tracking-widest text-neutral-500">Top Weight</div>
          <div className="font-mono font-bold text-xl text-white mt-1">{best ? fmt(best.weight) : '—'}<span className="text-xs text-neutral-500">{settings.unit}</span></div>
        </div>
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3">
          <div className="text-[10px] uppercase tracking-widest text-neutral-500">Volume</div>
          <div className="font-mono font-bold text-xl text-white mt-1">{fmt(Math.round(totalVolume))}<span className="text-xs text-neutral-500">{settings.unit}</span></div>
        </div>
      </div>

      {/* e1RM trend */}
      {sessions.length > 1 && (
        <div className="px-4 pt-5">
          <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-2 px-1">e1RM Trend</div>
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
            <E1RMChart sessions={sessions} unit={settings.unit} />
          </div>
        </div>
      )}

      {weightKeys.length > 0 && (
        <div className="px-4 pt-5">
          <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-2 px-1">Best Reps By Weight</div>
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-3 grid grid-cols-3 gap-2">
            {weightKeys.map(w => (
              <div key={w} className="text-center py-2">
                <div className="font-mono text-white">{w}{settings.unit}</div>
                <div className="font-mono text-[11px] text-orange-500">×{bestRepsByWeight[w]}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="px-4 pt-5">
        <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-2 px-1">All Sessions</div>
        <div className="space-y-3">
          {[...sessions].reverse().map((s, i) => (
            <div key={i} className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
              <div className="text-xs text-neutral-400 mb-2">
                {new Date(s.when).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
              </div>
              <div className="space-y-1">
                {s.sets.map((set, j) => {
                  const isWarmup = set.type === 'warmup';
                  const workingIdx = isWarmup ? null : s.sets.slice(0, j + 1).filter(x => x.type === 'working').length;
                  return (
                    <div key={j} className="flex items-center justify-between text-sm">
                      <span className="text-[10px] uppercase tracking-widest text-neutral-500 w-12">
                        {isWarmup ? 'Warm' : `Set ${workingIdx}`}
                      </span>
                      <span className="font-mono flex-1 text-white">{set.weight}{settings.unit} × {set.reps}</span>
                      <div className="flex items-center gap-1.5">
                        {!isWarmup && set.failure && <span className="text-[9px] uppercase tracking-widest text-red-400 font-bold">F</span>}
                        {!isWarmup && (
                          <span className={`text-[9px] uppercase tracking-widest font-bold ${
                            set.form === 'good' ? 'text-lime-400' : set.form === 'okay' ? 'text-yellow-400' : 'text-red-400'
                          }`}>{set.form?.[0] ?? '?'}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function E1RMChart({ sessions, unit }) {
  const points = sessions.map(s => {
    const best = s.sets
      .filter(x => x.type === 'working')
      .reduce((m, x) => Math.max(m, epley1RM(x.weight, x.reps)), 0);
    return { when: s.when, value: best };
  }).filter(p => p.value > 0);
  if (points.length === 0) return null;
  const max = Math.max(...points.map(p => p.value));
  const min = Math.min(...points.map(p => p.value));
  const range = Math.max(max - min, 1);
  const W = 300, H = 80, P = 8;
  const xStep = points.length > 1 ? (W - 2 * P) / (points.length - 1) : 0;
  const path = points.map((p, i) => {
    const x = P + i * xStep;
    const y = H - P - ((p.value - min) / range) * (H - 2 * P);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const fill = `${path} L${P + (points.length - 1) * xStep},${H - P} L${P},${H - P} Z`;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="none" className="overflow-visible">
        <path d={fill} fill="rgba(249, 115, 22, 0.15)" />
        <path d={path} fill="none" stroke="#f97316" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => {
          const x = P + i * xStep;
          const y = H - P - ((p.value - min) / range) * (H - 2 * P);
          return <circle key={i} cx={x} cy={y} r="2.5" fill="#f97316" />;
        })}
      </svg>
      <div className="flex justify-between mt-2 text-[10px] font-mono text-neutral-500">
        <span>{fmt(Math.round(min))}{unit}</span>
        <span>{fmt(Math.round(max))}{unit}</span>
      </div>
    </div>
  );
}

// ============================================================
// EDIT COMPLETED WORKOUT SCREEN
// ============================================================
//
// Lets the user retroactively fix a logged workout — typos in weight,
// missed sets, wrong rep counts, missing exercises, etc.
//
// We hold the in-progress edits in local state so the user can experiment
// freely without polluting history. Only on Save do we commit, and we set
// `edited: true` + `editedAt` so the History list can badge it. All the
// downstream consequences (e1RM PRs, progression targets, next-workout
// recommendations) recompute automatically because they derive from
// history — no cache invalidation needed.
function EditWorkoutScreen({ workout, settings, onSave, onBack }) {
  // Deep-clone so edits don't mutate the original until Save.
  const [draft, setDraft] = useState(() => JSON.parse(JSON.stringify(workout)));
  // Which set is currently being edited inline: { exIdx, setIdx } or null
  const [editing, setEditing] = useState(null);
  // Whether to show the "Add Exercise" inline picker
  const [addingExercise, setAddingExercise] = useState(false);
  // Whether a particular exercise's name is being renamed inline
  const [renamingIdx, setRenamingIdx] = useState(null);

  // Compare draft to original to decide whether to set `edited` on save.
  const isDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(workout),
    [draft, workout]
  );

  const updateSet = (exIdx, setIdx, patch) => {
    const exs = [...draft.exercises];
    const sets = [...exs[exIdx].sets];
    sets[setIdx] = { ...sets[setIdx], ...patch };
    exs[exIdx] = { ...exs[exIdx], sets };
    setDraft({ ...draft, exercises: exs });
  };

  const deleteSetAt = (exIdx, setIdx) => {
    const exs = [...draft.exercises];
    exs[exIdx] = {
      ...exs[exIdx],
      sets: exs[exIdx].sets.filter((_, i) => i !== setIdx),
    };
    setDraft({ ...draft, exercises: exs });
    if (editing?.exIdx === exIdx && editing?.setIdx === setIdx) setEditing(null);
  };

  const addSet = (exIdx) => {
    // Default new set: copy the last working set if any, else sensible defaults.
    const ex = draft.exercises[exIdx];
    const lastWorking = [...ex.sets].reverse().find(s => s.type === 'working');
    const newSet = lastWorking
      ? { ...lastWorking, timestamp: Date.now() }
      : {
          weight: 20, reps: 8, failure: true, form: 'good',
          type: 'working', timestamp: Date.now(),
        };
    const exs = [...draft.exercises];
    exs[exIdx] = { ...ex, sets: [...ex.sets, newSet] };
    setDraft({ ...draft, exercises: exs });
    // Auto-open the editor for the new row
    setEditing({ exIdx, setIdx: exs[exIdx].sets.length - 1 });
  };

  const renameExercise = (exIdx, newName) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const exs = [...draft.exercises];
    exs[exIdx] = { ...exs[exIdx], name: trimmed };
    setDraft({ ...draft, exercises: exs });
    setRenamingIdx(null);
  };

  const deleteExercise = (exIdx) => {
    const exs = draft.exercises.filter((_, i) => i !== exIdx);
    setDraft({ ...draft, exercises: exs });
  };

  const addExercise = (name) => {
    setDraft({
      ...draft,
      exercises: [...draft.exercises, { name, sets: [] }],
    });
    setAddingExercise(false);
  };

  const handleSave = () => {
    if (typeof document !== 'undefined' && document.activeElement?.blur) {
      document.activeElement.blur();
    }
    setTimeout(() => {
      // Drop exercises with zero sets — they're meaningless artifacts of
      // mid-edit state.
      const cleaned = {
        ...draft,
        exercises: draft.exercises.filter(e => e.sets.length > 0),
      };
      if (isDirty) {
        cleaned.edited = true;
        cleaned.editedAt = Date.now();
      }
      onSave(cleaned);
    }, 0);
  };

  return (
    <div className="pb-32 slide-up">
      <TopBar
        title="Edit Workout"
        onBack={onBack}
        subtitle={new Date(workout.startedAt).toLocaleDateString(undefined, {
          weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        })}
        right={
          <button
            onClick={handleSave}
            disabled={!isDirty}
            className={`text-[10px] uppercase tracking-widest font-bold px-2 ${isDirty ? 'text-orange-500' : 'text-neutral-700'}`}
          >
            Save
          </button>
        }
      />

      {isDirty && (
        <div className="mx-4 mt-4 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded-lg flex items-start gap-2">
          <AlertTriangle size={14} className="text-amber-400 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-amber-200 leading-relaxed">
            Unsaved changes. After saving, PRs, e1RM, and next-workout
            recommendations will recalculate using your edits.
          </div>
        </div>
      )}

      <div className="px-4 pt-4 space-y-5">
        {draft.exercises.map((ex, exIdx) => (
          <div key={exIdx} className="bg-neutral-900 border border-neutral-800 rounded-xl p-3">
            {/* Exercise header — name + rename + delete */}
            <div className="flex items-center gap-2 mb-3">
              {renamingIdx === exIdx ? (
                <input
                  type="text"
                  defaultValue={ex.name}
                  autoFocus
                  onBlur={(e) => renameExercise(exIdx, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.target.blur();
                    if (e.key === 'Escape') setRenamingIdx(null);
                  }}
                  className="flex-1 bg-neutral-800 border border-orange-500 rounded px-2 py-1 text-white text-sm"
                />
              ) : (
                <button
                  onClick={() => setRenamingIdx(exIdx)}
                  className="flex-1 text-left text-white font-medium text-base truncate"
                >
                  {ex.name}
                </button>
              )}
              <button
                onClick={() => setRenamingIdx(renamingIdx === exIdx ? null : exIdx)}
                aria-label="Rename exercise"
                className="text-neutral-500 hover:text-orange-400 p-1"
              >
                <Edit3 size={14} />
              </button>
              <button
                onClick={() => deleteExercise(exIdx)}
                aria-label="Delete exercise"
                className="text-neutral-600 hover:text-red-400 p-1"
              >
                <Trash2 size={14} />
              </button>
            </div>

            {/* Sets list — tap to edit inline */}
            <div className="space-y-1.5">
              {ex.sets.map((s, setIdx) => {
                const isOpen = editing?.exIdx === exIdx && editing?.setIdx === setIdx;
                const isWarmup = s.type === 'warmup';
                const label = isWarmup
                  ? 'Warm'
                  : `Set ${ex.sets.slice(0, setIdx + 1).filter(x => x.type === 'working').length}`;
                return (
                  <div key={setIdx} className="bg-neutral-950 border border-neutral-800 rounded-lg overflow-hidden">
                    {!isOpen ? (
                      <button
                        onClick={() => setEditing({ exIdx, setIdx })}
                        className="w-full px-3 py-2 flex items-center gap-3 text-left"
                      >
                        <div className="text-[10px] uppercase tracking-widest text-neutral-500 w-12 font-bold flex-shrink-0">
                          {label}
                        </div>
                        <div className="flex-1 font-mono">
                          <span className="text-white font-bold">{s.weight}{settings.unit}</span>
                          <span className="text-neutral-600 mx-2">×</span>
                          <span className="text-white font-bold">{s.reps}</span>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {!isWarmup && s.failure && <span className="text-[9px] uppercase tracking-widest text-red-400 font-bold">F</span>}
                          {!isWarmup && (
                            <span className={`text-[9px] uppercase tracking-widest font-bold ${
                              s.form === 'good' ? 'text-lime-400' : s.form === 'okay' ? 'text-yellow-400' : 'text-red-400'
                            }`}>{s.form?.[0] ?? '?'}</span>
                          )}
                          <Edit3 size={12} className="text-neutral-600 ml-1" />
                        </div>
                      </button>
                    ) : (
                      <InlineSetEditor
                        set={s}
                        settings={settings}
                        onChange={(patch) => updateSet(exIdx, setIdx, patch)}
                        onDelete={() => deleteSetAt(exIdx, setIdx)}
                        onClose={() => setEditing(null)}
                      />
                    )}
                  </div>
                );
              })}

              <button
                onClick={() => addSet(exIdx)}
                className="w-full border border-dashed border-neutral-700 hover:border-orange-500/50 hover:bg-neutral-800/50 rounded-lg py-2 text-xs text-neutral-400 hover:text-orange-400 flex items-center justify-center gap-1.5"
              >
                <Plus size={12} /> Add Set
              </button>
            </div>
          </div>
        ))}

        {/* Add Exercise */}
        {!addingExercise ? (
          <button
            onClick={() => setAddingExercise(true)}
            className="w-full border-2 border-dashed border-neutral-700 hover:border-orange-500/50 hover:bg-neutral-900 rounded-xl py-4 text-neutral-400 hover:text-orange-400 flex items-center justify-center gap-2 text-sm uppercase tracking-widest font-bold"
          >
            <Plus size={16} /> Add Exercise
          </button>
        ) : (
          <AddExerciseInline
            onCommit={addExercise}
            onCancel={() => setAddingExercise(false)}
          />
        )}

        <div className="pt-2 space-y-2">
          <PrimaryButton onClick={handleSave} disabled={!isDirty} icon={Save}>
            {isDirty ? 'Save Changes' : 'No Changes'}
          </PrimaryButton>
          <GhostButton onClick={onBack}>Cancel</GhostButton>
        </div>
      </div>
    </div>
  );
}

// Inline form for editing a single set. Shows all the same controls as the
// live workout screen but operates on a draft set.
function InlineSetEditor({ set, settings, onChange, onDelete, onClose }) {
  const [weight, setWeight] = useState(set.weight);
  const [reps, setReps] = useState(set.reps);
  const [failure, setFailure] = useState(!!set.failure);
  const [form, setForm] = useState(set.form || 'good');
  const [notes, setNotes] = useState(set.notes || '');
  const [type, setType] = useState(set.type || 'working');

  // Flush back on any change — the parent holds the draft, we just edit it.
  // We sync on blur of inputs (via commit in Stepper) and on every toggle.
  useEffect(() => {
    onChange({
      weight, reps,
      failure: type === 'warmup' ? false : failure,
      form: type === 'warmup' ? 'good' : form,
      type,
      notes: notes.trim() || undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weight, reps, failure, form, notes, type]);

  return (
    <div className="p-3 bg-neutral-900 border-t border-orange-500/40">
      <div className="flex gap-2 mb-3">
        <button
          onClick={() => setType('warmup')}
          className={`flex-1 py-1.5 rounded text-[10px] uppercase tracking-widest font-bold border ${type === 'warmup' ? 'bg-neutral-700 text-white border-neutral-600' : 'bg-transparent text-neutral-500 border-neutral-800'}`}
        >Warm-up</button>
        <button
          onClick={() => setType('working')}
          className={`flex-1 py-1.5 rounded text-[10px] uppercase tracking-widest font-bold border ${type === 'working' ? 'bg-orange-500 text-black border-orange-500' : 'bg-transparent text-neutral-500 border-neutral-800'}`}
        >Working</button>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-neutral-500 mb-1 px-1">Weight ({settings.unit})</div>
          <Stepper value={weight} onChange={setWeight} step={settings.increment} min={0} max={9999} />
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-neutral-500 mb-1 px-1">Reps</div>
          <Stepper value={reps} onChange={v => setReps(Math.round(v))} step={1} min={1} max={100} allowDecimal={false} />
        </div>
      </div>

      {type === 'working' && (
        <>
          <div className="flex gap-1.5 mb-2">
            <Pill active={failure} onClick={() => setFailure(true)} color="orange">Fail</Pill>
            <Pill active={!failure} onClick={() => setFailure(false)} color="orange">No Fail</Pill>
          </div>
          <div className="flex gap-1.5 mb-2">
            <Pill active={form === 'good'} onClick={() => setForm('good')} color="lime">Good</Pill>
            <Pill active={form === 'okay'} onClick={() => setForm('okay')} color="yellow">Okay</Pill>
            <Pill active={form === 'bad'} onClick={() => setForm('bad')} color="red">Bad</Pill>
          </div>
        </>
      )}

      <textarea
        value={notes}
        onChange={e => setNotes(e.target.value)}
        placeholder="Notes (optional)"
        rows={1}
        className="w-full bg-neutral-950 border border-neutral-800 rounded px-2 py-1.5 text-xs text-white placeholder:text-neutral-600 focus:outline-none focus:border-orange-500 mb-2"
      />

      <div className="flex gap-2">
        <button
          onClick={onDelete}
          className="flex-1 text-xs text-red-400 hover:bg-red-950 border border-red-900 rounded py-1.5 uppercase tracking-widest font-bold flex items-center justify-center gap-1"
        >
          <Trash2 size={12} /> Delete
        </button>
        <button
          onClick={onClose}
          className="flex-1 text-xs text-neutral-300 bg-neutral-800 hover:bg-neutral-700 rounded py-1.5 uppercase tracking-widest font-bold"
        >
          Done
        </button>
      </div>
    </div>
  );
}

// Compact picker for adding a new exercise during edit. Same search UX as
// the dedicated select screen but inline.
function AddExerciseInline({ onCommit, onCancel }) {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return COMMON_EXERCISES.slice(0, 8);
    return COMMON_EXERCISES.filter(e => e.name.toLowerCase().includes(q)).slice(0, 8);
  }, [query]);

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-3">
      <div className="flex items-center gap-2 mb-2">
        <Search size={14} className="text-neutral-500 flex-shrink-0" />
        <input
          type="text"
          value={query}
          autoFocus
          placeholder="Type exercise name..."
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && query.trim()) onCommit(query.trim());
            if (e.key === 'Escape') onCancel();
          }}
          className="flex-1 bg-transparent text-white text-sm focus:outline-none"
        />
        <button
          onClick={onCancel}
          aria-label="Cancel"
          className="text-neutral-500 hover:text-white p-1"
        >
          <X size={14} />
        </button>
      </div>
      <div className="space-y-1">
        {matches.map(e => (
          <button
            key={e.name}
            onClick={() => onCommit(e.name)}
            className="w-full bg-neutral-950 hover:bg-neutral-800 border border-neutral-800 rounded px-3 py-2 text-left text-sm text-white"
          >
            {e.name}
          </button>
        ))}
        {query.trim() && !matches.some(m => m.name.toLowerCase() === query.toLowerCase()) && (
          <button
            onClick={() => onCommit(query.trim())}
            className="w-full border-2 border-dashed border-orange-500/40 hover:border-orange-500 rounded px-3 py-2 text-left text-sm text-orange-400"
          >
            + Add custom: {query.trim()}
          </button>
        )}
      </div>
    </div>
  );
}


// ============================================================
// LOADING PROFILE EDITOR
// ============================================================
//
// Edits one loading profile — either the global default or a per-exercise
// override. All 5 profile types share the same scaffold (TopBar, save/back,
// preview strip) but the middle config block changes based on the picked
// type.

function ProfileEditorScreen({ title, profile, unit, isOverride, onSave, onResetToDefault, onBack }) {
  const [draft, setDraft] = useState(() => ({ ...DEFAULT_PROFILE, ...profile }));
  const setField = (k, v) => setDraft(d => ({ ...d, [k]: v }));
  const setType = (type) => {
    // When switching type, preserve common fields (min/max) but reset
    // type-specific config to sensible defaults.
    const base = { type, min: draft.min ?? 0, max: draft.max ?? 500 };
    if (type === 'fixed') base.increment = draft.increment ?? 2.5;
    if (type === 'dumbbell') base.increment = draft.increment ?? 2;
    if (type === 'plate') {
      base.barWeight = draft.barWeight ?? 20;
      base.plates = draft.plates ?? [
        { weight: 1.25, count: 4 },
        { weight: 2.5, count: 4 },
        { weight: 5, count: 4 },
        { weight: 10, count: 4 },
        { weight: 20, count: 4 },
      ];
    }
    if (type === 'stack' || type === 'custom') {
      base.weights = draft.weights ?? [];
    }
    setDraft(base);
  };

  // Live preview — show the first N available weights so the user can
  // sanity-check the config.
  const preview = useMemo(() => {
    try {
      return availableWeights(draft);
    } catch {
      return [];
    }
  }, [draft]);

  const handleSave = () => {
    if (typeof document !== 'undefined' && document.activeElement?.blur) {
      document.activeElement.blur();
    }
    setTimeout(() => {
      const clean = { ...draft };
      if (clean.type === 'stack' || clean.type === 'custom') {
        clean.weights = (clean.weights || [])
          .map(Number)
          .filter(w => Number.isFinite(w) && w > 0)
          .sort((a, b) => a - b);
        clean.weights = Array.from(new Set(clean.weights));
      }
      if (clean.type === 'plate') {
        clean.plates = (clean.plates || []).filter(p => p.weight > 0 && p.count > 0);
      }
      onSave(clean);
    }, 0);
  };

  return (
    <div className="pb-32 slide-up">
      <TopBar
        title={title}
        onBack={onBack}
        subtitle={isOverride ? 'Custom override' : 'Global default'}
        right={
          <button onClick={handleSave} className="text-[10px] uppercase tracking-widest text-orange-500 font-bold px-2">
            Save
          </button>
        }
      />

      <div className="px-4 pt-4 space-y-5">
        {/* Type picker */}
        <Section label="Equipment Type">
          <div className="grid grid-cols-3 gap-2">
            {PROFILE_TYPES.map(t => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={`py-2.5 rounded-lg text-xs uppercase tracking-widest font-bold border ${
                  draft.type === t
                    ? 'bg-orange-500 text-black border-orange-500'
                    : 'bg-transparent text-neutral-400 border-neutral-800'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="text-[10px] text-neutral-500 mt-2 px-1 leading-relaxed">
            {profileTypeHelp(draft.type)}
          </div>
        </Section>

        {/* Type-specific config */}
        {draft.type === 'fixed' && (
          <Section label="Increment">
            <Stepper value={draft.increment ?? 2.5} onChange={v => setField('increment', v)} step={0.25} min={0.25} max={50} />
          </Section>
        )}

        {draft.type === 'dumbbell' && (
          <Section label="Dumbbell Step">
            <Stepper value={draft.increment ?? 2} onChange={v => setField('increment', v)} step={0.5} min={0.5} max={20} />
            <div className="text-[10px] text-neutral-500 mt-2 px-1">
              Each dumbbell weight available (e.g. 2 means dumbbells exist as 2, 4, 6, 8, 10 …).
            </div>
          </Section>
        )}

        {draft.type === 'plate' && (
          <PlateEditor
            bar={draft.barWeight ?? 20}
            plates={draft.plates ?? []}
            unit={unit}
            onChange={(bar, plates) => setDraft(d => ({ ...d, barWeight: bar, plates }))}
          />
        )}

        {(draft.type === 'stack' || draft.type === 'custom') && (
          <CustomWeightsEditor
            weights={draft.weights ?? []}
            unit={unit}
            onChange={(weights) => setField('weights', weights)}
            hint={draft.type === 'stack'
              ? 'Enter each pin position on the machine stack. The app will only recommend these weights.'
              : 'Enter every available weight. Decimals like 1.2 or 3.7 are fine.'}
          />
        )}

        <Section label="Range Limits">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5 px-1">Min ({unit})</div>
              <Stepper value={draft.min ?? 0} onChange={v => setField('min', v)} step={1} min={0} max={1000} />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5 px-1">Max ({unit})</div>
              <Stepper value={draft.max ?? 500} onChange={v => setField('max', v)} step={5} min={1} max={2000} />
            </div>
          </div>
        </Section>

        {/* Preview */}
        <Section label={`Available Weights · ${preview.length} positions`}>
          {preview.length === 0 ? (
            <div className="text-xs text-neutral-500 italic px-1">
              No weights configured yet. Add some above to see the preview.
            </div>
          ) : (
            <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3 flex flex-wrap gap-1.5">
              {preview.slice(0, 24).map((w, i) => (
                <span key={i} className="font-mono text-xs text-neutral-300 bg-neutral-800 rounded px-2 py-0.5">
                  {fmt(w)}{unit}
                </span>
              ))}
              {preview.length > 24 && (
                <span className="font-mono text-xs text-neutral-500 px-2 py-0.5">
                  +{preview.length - 24} more
                </span>
              )}
            </div>
          )}
        </Section>

        <div className="pt-2 space-y-2">
          <PrimaryButton onClick={handleSave} icon={Save}>Save Profile</PrimaryButton>
          {onResetToDefault && (
            <GhostButton onClick={onResetToDefault} icon={RotateCcw}>
              Use Default Instead
            </GhostButton>
          )}
        </div>
      </div>
    </div>
  );
}

function profileTypeHelp(type) {
  switch (type) {
    case 'fixed':
      return 'Linear weight increments — most common for plate-loaded barbells with a standard plate set.';
    case 'dumbbell':
      return 'For exercises using dumbbells. Dumbbells come in fixed jumps (commonly 2kg or 5lb steps).';
    case 'plate':
      return 'Configure the bar weight and which plates you have. The app generates every reachable total.';
    case 'stack':
      return 'For machine stacks. Enter each available pin position.';
    case 'custom':
      return 'For unusual machines (Matrix, certain pin-loaded systems) with non-linear weight options including decimals.';
    default:
      return '';
  }
}

function PlateEditor({ bar, plates, unit, onChange }) {
  const updateBar = (v) => onChange(v, plates);
  const updatePlate = (idx, patch) => {
    const next = plates.map((p, i) => i === idx ? { ...p, ...patch } : p);
    onChange(bar, next);
  };
  const removePlate = (idx) => onChange(bar, plates.filter((_, i) => i !== idx));
  const addPlate = () => onChange(bar, [...plates, { weight: 1, count: 2 }]);

  return (
    <>
      <Section label="Bar Weight">
        <Stepper value={bar} onChange={updateBar} step={0.5} min={0} max={50} />
      </Section>
      <Section label="Plates (per side)">
        <div className="space-y-2">
          {plates.map((p, i) => (
            <div key={i} className="bg-neutral-900 border border-neutral-800 rounded-lg p-2.5 flex items-center gap-2">
              <div className="flex-1">
                <div className="text-[9px] uppercase tracking-widest text-neutral-500 mb-1">Weight ({unit})</div>
                <Stepper
                  value={p.weight}
                  onChange={v => updatePlate(i, { weight: v })}
                  step={0.25} min={0.25} max={50}
                />
              </div>
              <div className="flex-1">
                <div className="text-[9px] uppercase tracking-widest text-neutral-500 mb-1">Per side</div>
                <Stepper
                  value={p.count}
                  onChange={v => updatePlate(i, { count: Math.round(v) })}
                  step={1} min={0} max={20}
                  allowDecimal={false}
                />
              </div>
              <button
                onClick={() => removePlate(i)}
                aria-label="Remove plate"
                className="self-end text-neutral-600 hover:text-red-400 p-2"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <button
            onClick={addPlate}
            className="w-full border border-dashed border-neutral-700 hover:border-orange-500/50 hover:bg-neutral-900 rounded-lg py-2 text-xs text-neutral-400 hover:text-orange-400 flex items-center justify-center gap-1.5"
          >
            <Plus size={12} /> Add Plate Type
          </button>
        </div>
      </Section>
    </>
  );
}

function CustomWeightsEditor({ weights, unit, onChange, hint }) {
  const [newWeight, setNewWeight] = useState(0);
  const [bulkText, setBulkText] = useState('');

  const sortedWeights = useMemo(() => [...(weights || [])].sort((a, b) => a - b), [weights]);

  const addWeight = (w) => {
    if (!Number.isFinite(w) || w <= 0) return;
    if (weights.includes(w)) return;
    onChange([...weights, w].sort((a, b) => a - b));
  };
  const removeWeight = (w) => onChange(weights.filter(x => x !== w));
  const commitBulk = () => {
    const parsed = bulkText
      .split(/[\s,;\n]+/)
      .map(s => parseFloat(s))
      .filter(n => Number.isFinite(n) && n > 0);
    if (!parsed.length) return;
    const merged = Array.from(new Set([...weights, ...parsed])).sort((a, b) => a - b);
    onChange(merged);
    setBulkText('');
  };

  return (
    <>
      <Section label="Available Weights">
        <div className="text-[10px] text-neutral-500 mb-2 px-1 leading-relaxed">{hint}</div>

        {sortedWeights.length > 0 && (
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3 mb-2 flex flex-wrap gap-1.5">
            {sortedWeights.map(w => (
              <span key={w} className="font-mono text-xs text-neutral-200 bg-neutral-800 rounded px-2 py-1 flex items-center gap-1.5">
                {fmt(w)}{unit}
                <button
                  onClick={() => removeWeight(w)}
                  aria-label={`Remove ${w}`}
                  className="text-neutral-500 hover:text-red-400"
                >
                  <X size={10} strokeWidth={3} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <div className="flex-1">
            <div className="text-[9px] uppercase tracking-widest text-neutral-500 mb-1 px-1">Add weight</div>
            <Stepper value={newWeight} onChange={setNewWeight} step={1} min={0} max={1000} />
          </div>
          <button
            onClick={() => { addWeight(newWeight); setNewWeight(0); }}
            disabled={newWeight <= 0}
            className="h-[40px] px-3 bg-orange-500 hover:bg-orange-400 disabled:bg-neutral-800 disabled:text-neutral-600 text-black font-bold uppercase tracking-wider text-xs rounded-lg"
          >
            Add
          </button>
        </div>

        <div className="mt-3">
          <div className="text-[9px] uppercase tracking-widest text-neutral-500 mb-1 px-1">Bulk paste</div>
          <textarea
            value={bulkText}
            onChange={e => setBulkText(e.target.value)}
            placeholder="e.g. 17, 22, 27, 32, 37, 42"
            rows={2}
            className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-2 py-1.5 text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-orange-500 font-mono"
          />
          <button
            onClick={commitBulk}
            disabled={!bulkText.trim()}
            className="w-full mt-1.5 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 text-neutral-300 text-xs uppercase tracking-widest font-bold py-2 rounded-lg"
          >
            Parse & Add
          </button>
        </div>
      </Section>
    </>
  );
}

function SettingsScreen({ settings, onChange, history, onReset, onExport, install, online, onShowInstall }) {
  const update = (k, v) => onChange({ ...settings, [k]: v });

  // Sub-screen: editing a specific exercise's loading profile, or the
  // global default. null = top-level settings view. 'default' = editing
  // the global default. otherwise the exercise name being edited.
  const [editingProfileFor, setEditingProfileFor] = useState(null);

  // Known exercise names — union of past history names and built-ins
  // that have been used. We only show those that have been logged at
  // least once, plus user-created ones, to keep the list relevant.
  const knownExercises = useMemo(() => {
    const names = new Set();
    history.forEach(w => w.exercises.forEach(e => names.add(e.name)));
    return Array.from(names).sort();
  }, [history]);

  // Sub-screen rendering — pull out for clarity. Same scaffold as the
  // top-level settings page so the user sees a TopBar with a back button
  // and consistent layout.
  if (editingProfileFor !== null) {
    const target = editingProfileFor;
    const currentProfile = target === 'default'
      ? (settings.defaultProfile || DEFAULT_PROFILE)
      : (settings.exerciseProfiles?.[target] || settings.defaultProfile || DEFAULT_PROFILE);

    const handleProfileSave = (newProfile) => {
      if (target === 'default') {
        onChange({ ...settings, defaultProfile: newProfile });
      } else {
        onChange({
          ...settings,
          exerciseProfiles: { ...(settings.exerciseProfiles || {}), [target]: newProfile },
        });
      }
      setEditingProfileFor(null);
    };

    const handleProfileReset = () => {
      // "Reset to default" — remove the per-exercise override so it inherits.
      if (target !== 'default') {
        const next = { ...(settings.exerciseProfiles || {}) };
        delete next[target];
        onChange({ ...settings, exerciseProfiles: next });
      }
      setEditingProfileFor(null);
    };

    return (
      <ProfileEditorScreen
        title={target === 'default' ? 'Default Loading' : target}
        profile={currentProfile}
        unit={settings.unit}
        isOverride={target !== 'default' && !!(settings.exerciseProfiles?.[target])}
        onSave={handleProfileSave}
        onResetToDefault={target !== 'default' ? handleProfileReset : null}
        onBack={() => setEditingProfileFor(null)}
      />
    );
  }

  // Format storage usage in human terms.
  const storageLine = useMemo(() => {
    const info = install.storageInfo;
    if (!info || !info.quota) return null;
    const usedKB = Math.round(info.usage / 1024);
    const quotaMB = Math.round(info.quota / (1024 * 1024));
    return `${usedKB} KB used of ${quotaMB} MB available`;
  }, [install.storageInfo]);

  return (
    <div className="pb-24 slide-up">
      <TopBar title="Settings" />

      <div className="px-4 pt-4 space-y-5">
        {!install.isStandalone && (
          <Section label="App Install">
            <button
              onClick={onShowInstall}
              className="w-full bg-orange-500 hover:bg-orange-400 active:bg-orange-600 text-black font-bold uppercase tracking-wider py-3.5 rounded-lg flex items-center justify-center gap-2"
            >
              <Smartphone size={18} strokeWidth={2.5} />
              Install on this device
            </button>
            <div className="text-[10px] text-neutral-500 mt-2 px-1">
              Adds HyperCoach to your home screen. Once installed, the app works
              fully offline — no server, no internet required.
            </div>
          </Section>
        )}
        {install.isStandalone && (
          <Section label="App Status">
            <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3.5 space-y-2">
              <div className="flex items-center gap-3">
                <CheckCircle2 size={18} className="text-lime-400 flex-shrink-0" />
                <div className="text-sm text-neutral-200">Installed · running standalone</div>
              </div>
              <div className="flex items-center gap-3">
                {online ? (
                  <Wifi size={18} className="text-neutral-400 flex-shrink-0" />
                ) : (
                  <WifiOff size={18} className="text-amber-400 flex-shrink-0" />
                )}
                <div className="text-sm text-neutral-300">
                  {online ? 'Online — but app does not need it.' : 'Offline — app still works.'}
                </div>
              </div>
              {install.persisted?.persisted && (
                <div className="flex items-center gap-3">
                  <Shield size={18} className="text-lime-400 flex-shrink-0" />
                  <div className="text-sm text-neutral-300">Storage marked persistent · safe from auto-eviction.</div>
                </div>
              )}
              {install.persisted && !install.persisted.persisted && install.persisted.supported && (
                <div className="flex items-center gap-3">
                  <AlertTriangle size={18} className="text-amber-400 flex-shrink-0" />
                  <div className="text-sm text-neutral-300">
                    Storage not yet persistent. Browser may evict data after long inactivity.
                  </div>
                </div>
              )}
              {storageLine && (
                <div className="text-[10px] text-neutral-500 pt-2 border-t border-neutral-800">
                  {storageLine}
                </div>
              )}
            </div>
          </Section>
        )}

        <Section label="Units">
          <div className="flex gap-2">
            <Pill active={settings.unit === 'kg'} onClick={() => update('unit', 'kg')}>kg</Pill>
            <Pill active={settings.unit === 'lbs'} onClick={() => update('unit', 'lbs')}>lbs</Pill>
          </div>
        </Section>

        <Section label="Manual Stepper Increment">
          <div className="grid grid-cols-4 gap-2">
            {(settings.unit === 'kg' ? [1, 1.25, 2.5, 5] : [1, 2.5, 5, 10]).map(v => (
              <Pill key={v} active={settings.increment === v} onClick={() => update('increment', v)}>
                {v}{settings.unit}
              </Pill>
            ))}
          </div>
          <div className="text-[10px] text-neutral-500 mt-2 px-1">
            Only affects the +/− buttons when typing a weight manually.
            Recommendations are snapped using the exercise's loading profile below.
          </div>
        </Section>

        {/* Exercise Loading Settings — the killer feature */}
        <Section label="Exercise Loading">
          <button
            onClick={() => setEditingProfileFor('default')}
            className="w-full bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 rounded-lg p-3 flex items-center justify-between text-left mb-2"
          >
            <div className="flex items-center gap-3 min-w-0">
              <Sliders size={16} className="text-orange-500 flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-sm text-white">Default Loading Profile</div>
                <div className="text-[10px] text-neutral-500 truncate">
                  {describeProfile(settings.defaultProfile || DEFAULT_PROFILE, settings.unit)}
                </div>
              </div>
            </div>
            <ChevronRight size={16} className="text-neutral-600 flex-shrink-0" />
          </button>

          {knownExercises.length > 0 ? (
            <div className="space-y-1.5">
              <div className="text-[9px] uppercase tracking-widest text-neutral-600 mt-3 mb-1 px-1">
                Per-Exercise Overrides
              </div>
              {knownExercises.map(name => {
                const hasOverride = !!(settings.exerciseProfiles?.[name]);
                const profile = settings.exerciseProfiles?.[name];
                return (
                  <button
                    key={name}
                    onClick={() => setEditingProfileFor(name)}
                    className="w-full bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 rounded-lg p-3 flex items-center justify-between text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-white truncate">{name}</span>
                        {hasOverride && (
                          <span className="text-[9px] uppercase tracking-widest text-orange-400 bg-orange-500/10 border border-orange-500/30 rounded px-1.5 py-0.5 font-bold flex-shrink-0">
                            Custom
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-neutral-500 truncate mt-0.5">
                        {hasOverride
                          ? describeProfile(profile, settings.unit)
                          : 'Inherits default'}
                      </div>
                    </div>
                    <ChevronRight size={16} className="text-neutral-600 flex-shrink-0 ml-2" />
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="text-[10px] text-neutral-600 mt-2 px-1 leading-relaxed">
              Log an exercise once and it'll appear here so you can configure its
              equipment-specific weight options.
            </div>
          )}
        </Section>

        <Section label={`Target Rep Range (${settings.targetMin}–${settings.targetMax})`}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5 px-1">Min</div>
              <Stepper value={settings.targetMin} onChange={v => update('targetMin', Math.round(v))} step={1} min={1} max={settings.targetMax - 1} allowDecimal={false} />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5 px-1">Max</div>
              <Stepper value={settings.targetMax} onChange={v => update('targetMax', Math.round(v))} step={1} min={settings.targetMin + 1} max={30} allowDecimal={false} />
            </div>
          </div>
        </Section>

        <Section label={`Ideal Target Reps (${settings.targetIdeal})`}>
          <Stepper value={settings.targetIdeal} onChange={v => update('targetIdeal', Math.round(v))} step={1} min={settings.targetMin} max={settings.targetMax} allowDecimal={false} />
        </Section>

        <Section label="Data">
          <div className="space-y-2">
            <GhostButton onClick={onExport} icon={Download}>Export Workout History</GhostButton>
            <GhostButton onClick={onReset} icon={Trash2} danger>Reset All Data</GhostButton>
          </div>
          <div className="text-[10px] text-neutral-500 mt-3 px-1">
            {history.length} workout{history.length !== 1 ? 's' : ''} saved locally.
          </div>
        </Section>

        <div className="pt-2 text-center">
          <div className="font-display text-2xl text-neutral-700 uppercase tracking-wider">HyperCoach</div>
          <div className="text-[10px] uppercase tracking-widest text-neutral-700">Adaptive Hypertrophy v1</div>
        </div>
      </div>
    </div>
  );
}

function Section({ label, children }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-2 px-1">{label}</div>
      {children}
    </div>
  );
}

// ============================================================
// CONFIRM MODAL
// ============================================================
function ConfirmModal({ open, title, body, confirmLabel, onConfirm, onCancel, danger }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-4" onClick={onCancel}>
      <div className="w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-xl p-5 slide-up" onClick={e => e.stopPropagation()}>
        <div className="font-display text-xl text-white uppercase mb-2">{title}</div>
        <div className="text-sm text-neutral-400 mb-5">{body}</div>
        <div className="grid grid-cols-2 gap-2">
          <GhostButton onClick={onCancel}>Cancel</GhostButton>
          <button
            onClick={onConfirm}
            className={`w-full font-bold uppercase tracking-wider text-sm py-3.5 rounded-lg ${danger ? 'bg-red-600 hover:bg-red-500 text-white' : 'bg-orange-500 hover:bg-orange-400 text-black'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// MAIN APP
// ============================================================
export default function App() {
  const [screen, setScreen] = useState('home');
  const [history, setHistory] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [workout, setWorkout] = useState(null);
  const [activeExerciseIdx, setActiveExerciseIdx] = useState(0);
  const [completedWorkout, setCompletedWorkout] = useState(null);
  const [historySnapshotForSummary, setHistorySnapshotForSummary] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [showInstall, setShowInstall] = useState(false);
  // Editing a previously-completed workout. Holds the original; the edit
  // screen tracks its own draft locally.
  const [editingWorkout, setEditingWorkout] = useState(null);
  const install = useInstallPrompt();

  // Track online/offline so we can give the user honest feedback. The app
  // works the same either way — this is just transparency.
  const [online, setOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // Load
  useEffect(() => {
    const h = storage.get(STORAGE_KEYS.history);
    const s = storage.get(STORAGE_KEYS.settings);
    if (Array.isArray(h)) {
      // Migration: older workouts have no `status` field. Treat them as
      // completed so they keep working as session history.
      setHistory(h.map(w => w.status ? w : { ...w, status: 'completed' }));
    }
    if (s) setSettings({ ...DEFAULT_SETTINGS, ...s });
    setLoaded(true);
  }, []);

  // Persist
  useEffect(() => { if (loaded) storage.set(STORAGE_KEYS.history, history); }, [history, loaded]);
  useEffect(() => { if (loaded) storage.set(STORAGE_KEYS.settings, settings); }, [settings, loaded]);

  // Most-recently-paused workouts surface on Home for resume.
  const pausedWorkouts = useMemo(
    () => history
      .filter(w => w.status === 'paused')
      .sort((a, b) => (b.pausedAt || b.startedAt) - (a.pausedAt || a.startedAt)),
    [history]
  );

  const startWorkout = () => {
    setWorkout({
      id: `w_${Date.now()}`,
      startedAt: Date.now(),
      exercises: [],
      status: 'in_progress',
    });
    setScreen('exercise-select');
  };

  const startWorkoutWith = (name) => {
    const w = {
      id: `w_${Date.now()}`,
      startedAt: Date.now(),
      exercises: [{ name, sets: [] }],
      status: 'in_progress',
    };
    setWorkout(w);
    setActiveExerciseIdx(0);
    setScreen('workout');
  };

  const handleExerciseSelected = (name) => {
    if (!workout) {
      startWorkoutWith(name);
      return;
    }
    const existingIdx = workout.exercises.findIndex(e => e.name === name);
    if (existingIdx >= 0) {
      setActiveExerciseIdx(existingIdx);
    } else {
      const next = { ...workout, exercises: [...workout.exercises, { name, sets: [] }] };
      setWorkout(next);
      setActiveExerciseIdx(next.exercises.length - 1);
    }
    setScreen('workout');
  };

  const logSet = (set) => {
    if (!workout) return;
    const exs = [...workout.exercises];
    exs[activeExerciseIdx] = {
      ...exs[activeExerciseIdx],
      sets: [...exs[activeExerciseIdx].sets, set],
    };
    setWorkout({ ...workout, exercises: exs });
  };

  const deleteSet = (setIdx) => {
    if (!workout) return;
    const ex = workout.exercises[activeExerciseIdx];
    if (!ex || !ex.sets[setIdx]) return;
    const target = ex.sets[setIdx];
    const isWarmup = target.type === 'warmup';
    const setLabel = isWarmup
      ? 'warm-up'
      : `set ${ex.sets.slice(0, setIdx + 1).filter(x => x.type === 'working').length}`;
    setConfirm({
      title: `Delete ${setLabel}?`,
      body: `${target.weight}${settings.unit} × ${target.reps}${target.notes ? ` · ${target.notes}` : ''}. This can't be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => {
        const exs = [...workout.exercises];
        exs[activeExerciseIdx] = {
          ...exs[activeExerciseIdx],
          sets: exs[activeExerciseIdx].sets.filter((_, i) => i !== setIdx),
        };
        setWorkout({ ...workout, exercises: exs });
        setConfirm(null);
      },
      onCancel: () => setConfirm(null),
    });
  };

  const deleteWorkout = (w) => {
    const date = new Date(w.startedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const exNames = w.exercises.map(e => e.name).join(', ');
    const setCount = w.exercises.reduce((s, e) => s + e.sets.filter(x => x.type === 'working').length, 0);
    setConfirm({
      title: 'Delete workout?',
      body: `${date} · ${setCount} working sets · ${exNames || 'No exercises'}. This permanently removes the session.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => {
        setHistory(history.filter(x => x.id !== w.id));
        setConfirm(null);
      },
      onCancel: () => setConfirm(null),
    });
  };

  // Edit a completed workout. The screen tracks its own draft state; on
  // Save we replace the history record. PRs, e1RM, progression targets,
  // and next-workout recommendations all derive from history so they
  // recompute automatically.
  const startEditingWorkout = (w) => {
    setEditingWorkout(w);
    setScreen('edit-workout');
  };

  const saveEditedWorkout = (updated) => {
    // Replace by id; if all exercises got removed during edit, drop it.
    if (!updated.exercises.length) {
      setHistory(history.filter(w => w.id !== updated.id));
    } else {
      setHistory(history.map(w => w.id === updated.id ? updated : w));
    }
    setEditingWorkout(null);
    setScreen('history');
  };

  const cancelEditingWorkout = () => {
    setEditingWorkout(null);
    setScreen('history');
  };

  // ============================================================
  // Workout lifecycle: finish / pause / discard / resume
  // ============================================================

  const finishWorkout = () => {
    if (!workout) return;
    // No sets at all → silently discard, no confirm. Nothing to confirm.
    const hasAnySets = workout.exercises.some(e => e.sets.length > 0);
    if (!hasAnySets) {
      setWorkout(null);
      setScreen('home');
      return;
    }
    setConfirm({
      title: 'Finish workout?',
      body: 'This marks the workout as completed. Recommendations and PRs will update based on it.',
      confirmLabel: 'Finish',
      onConfirm: () => {
        const valid = {
          ...workout,
          exercises: workout.exercises.filter(e => e.sets.length > 0),
          status: 'completed',
          completedAt: Date.now(),
        };
        setHistorySnapshotForSummary(history);
        setCompletedWorkout(valid);
        setHistory([...history, valid]);
        setWorkout(null);
        setConfirm(null);
        setScreen('summary');
      },
      onCancel: () => setConfirm(null),
    });
  };

  // Silently save the current workout as paused. No confirm — exiting the
  // workout should be friction-free. The user can resume from Home.
  const pauseWorkout = () => {
    if (!workout) return;
    // Don't pause if there's nothing in the workout — just discard quietly.
    const hasAnySets = workout.exercises.some(e => e.sets.length > 0);
    if (!hasAnySets) {
      setWorkout(null);
      setScreen('home');
      return;
    }
    const paused = {
      ...workout,
      status: 'paused',
      pausedAt: Date.now(),
    };
    // Replace if this workout was already in history (resumed-then-paused),
    // else append.
    const existsIdx = history.findIndex(w => w.id === paused.id);
    let nextHistory;
    if (existsIdx >= 0) {
      nextHistory = [...history];
      nextHistory[existsIdx] = paused;
    } else {
      nextHistory = [...history, paused];
    }
    setHistory(nextHistory);
    setWorkout(null);
    setScreen('home');
  };

  const discardWorkout = () => {
    if (!workout) return;
    const hasAnySets = workout.exercises.some(e => e.sets.length > 0);
    // No sets → no need to confirm, just drop.
    if (!hasAnySets) {
      setWorkout(null);
      setScreen('home');
      return;
    }
    setConfirm({
      title: 'Discard workout?',
      body: 'All logged sets will be permanently deleted. This cannot be undone.',
      confirmLabel: 'Discard',
      danger: true,
      onConfirm: () => {
        // Also remove from history in case this was a previously-paused workout.
        setHistory(history.filter(w => w.id !== workout.id));
        setWorkout(null);
        setConfirm(null);
        setScreen('home');
      },
      onCancel: () => setConfirm(null),
    });
  };

  const resumePausedWorkout = (workoutId) => {
    const target = history.find(w => w.id === workoutId && w.status === 'paused');
    if (!target) return;

    // If there's an in-progress workout, save it as paused before swapping.
    // This avoids losing the user's current work when they tap Resume by mistake.
    let nextHistory = history.filter(w => w.id !== workoutId);
    if (workout && workout.exercises.some(e => e.sets.length > 0)) {
      const stashed = { ...workout, status: 'paused', pausedAt: Date.now() };
      const existsIdx = nextHistory.findIndex(w => w.id === stashed.id);
      if (existsIdx >= 0) {
        nextHistory = [...nextHistory];
        nextHistory[existsIdx] = stashed;
      } else {
        nextHistory = [...nextHistory, stashed];
      }
    }

    const { status: _s, pausedAt: _p, ...resumed } = target;
    setWorkout({ ...resumed, status: 'in_progress' });
    setHistory(nextHistory);
    // Pick the last exercise that has any sets, or first overall.
    const lastWithSets = resumed.exercises.findIndex(e => e.sets.length > 0);
    setActiveExerciseIdx(Math.max(0, lastWithSets));
    setScreen('workout');
  };

  const discardPausedWorkout = (workoutId) => {
    const target = history.find(w => w.id === workoutId);
    if (!target) return;
    setConfirm({
      title: 'Discard paused workout?',
      body: 'This deletes the paused session permanently.',
      confirmLabel: 'Discard',
      danger: true,
      onConfirm: () => {
        setHistory(history.filter(w => w.id !== workoutId));
        setConfirm(null);
      },
      onCancel: () => setConfirm(null),
    });
  };

  const handleAddExercise = () => setScreen('exercise-select');

  const handleBackFromSelect = () => {
    if (workout && workout.exercises.length > 0) {
      setScreen('workout');
    } else {
      // No exercises selected yet → don't leave a junk paused workout
      setWorkout(null);
      setScreen('home');
    }
  };

  // Back button on the workout screen pauses silently. The user gets their
  // workout back from the Home screen's Resume card.
  const handleBackFromWorkout = () => {
    pauseWorkout();
  };

  const handleExport = () => {
    const data = JSON.stringify({ history, settings, exportedAt: Date.now() }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hypercoach-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleReset = () => {
    setConfirm({
      title: 'Wipe all data?',
      body: 'This deletes every workout and PR. There is no recovery. Export first if you want a backup.',
      confirmLabel: 'Wipe Everything',
      danger: true,
      onConfirm: () => {
        setHistory([]);
        storage.del(STORAGE_KEYS.history);
        setConfirm(null);
      },
      onCancel: () => setConfirm(null),
    });
  };

  const inWorkout = screen === 'workout' || screen === 'exercise-select' || screen === 'summary' || screen === 'edit-workout';

  if (!loaded) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center">
        <FontStyles />
        <Dumbbell size={32} className="text-orange-500 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-white font-body">
      <FontStyles />
      <div className="max-w-md mx-auto min-h-screen relative">
        {screen === 'home' && (
          <HomeScreen
            history={history}
            onStart={startWorkout}
            onOpenExercise={(name) => startWorkoutWith(name)}
            settings={settings}
            install={install}
            online={online}
            onShowInstall={() => setShowInstall(true)}
            pausedWorkouts={pausedWorkouts}
            onResumePaused={resumePausedWorkout}
            onDiscardPaused={discardPausedWorkout}
          />
        )}
        {screen === 'exercise-select' && (
          <ExerciseSelectScreen
            history={history}
            onSelect={handleExerciseSelected}
            onBack={handleBackFromSelect}
          />
        )}
        {screen === 'workout' && workout && workout.exercises[activeExerciseIdx] && (
          <WorkoutScreen
            workout={workout}
            activeExerciseIdx={activeExerciseIdx}
            history={history}
            settings={settings}
            onLogSet={logSet}
            onDeleteSet={deleteSet}
            onAddExercise={handleAddExercise}
            onFinishExercise={() => setScreen('exercise-select')}
            onFinishWorkout={finishWorkout}
            onDiscardWorkout={discardWorkout}
            onBack={handleBackFromWorkout}
          />
        )}
        {screen === 'summary' && completedWorkout && (
          <SummaryScreen
            workout={completedWorkout}
            history={historySnapshotForSummary}
            settings={settings}
            onDone={() => {
              setCompletedWorkout(null);
              setScreen('home');
            }}
          />
        )}
        {screen === 'history' && (
          <HistoryScreen
            history={history}
            settings={settings}
            onDeleteWorkout={deleteWorkout}
            onEditWorkout={startEditingWorkout}
          />
        )}
        {screen === 'edit-workout' && editingWorkout && (
          <EditWorkoutScreen
            workout={editingWorkout}
            settings={settings}
            onSave={saveEditedWorkout}
            onBack={cancelEditingWorkout}
          />
        )}
        {screen === 'settings' && (
          <SettingsScreen
            settings={settings}
            onChange={setSettings}
            history={history}
            onReset={handleReset}
            onExport={handleExport}
            install={install}
            online={online}
            onShowInstall={() => setShowInstall(true)}
          />
        )}

        <BottomNav screen={screen} onNav={setScreen} inWorkout={inWorkout} />
        <ConfirmModal
          open={!!confirm}
          title={confirm?.title}
          body={confirm?.body}
          confirmLabel={confirm?.confirmLabel}
          onConfirm={confirm?.onConfirm}
          onCancel={confirm?.onCancel}
          danger={confirm?.danger}
        />
        <InstallModal
          open={showInstall}
          onClose={() => setShowInstall(false)}
          platform={install.platform}
          canPromptInstall={install.canPromptInstall}
          onPromptInstall={install.promptInstall}
        />
      </div>
    </div>
  );
}
