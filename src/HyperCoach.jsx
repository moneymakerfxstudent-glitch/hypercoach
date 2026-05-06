import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Dumbbell, Plus, Minus, Check, X, ChevronLeft, ChevronRight,
  Home as HomeIcon, History as HistoryIcon, Settings as SettingsIcon, Flame,
  TrendingUp, Trophy, Target, Save, Download, Trash2, Search,
  Activity, Zap, Award, Clock, BarChart3, Edit3, ArrowRight,
  CheckCircle2, AlertTriangle, Info, Play, Square, Repeat,
  LifeBuoy, Shield, Smartphone,
} from 'lucide-react';
import { useInstallPrompt } from './useInstallPrompt.js';
import { InstallModal } from './InstallModal.jsx';

// ============================================================
// CONSTANTS
// ============================================================
const DEFAULT_SETTINGS = {
  unit: 'kg',
  increment: 2.5,
  targetMin: 7,
  targetMax: 12,
  targetIdeal: 9,
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
const roundIncrement = (w, inc) => Math.max(inc, Math.round(w / inc) * inc);
const fmt = (n) => {
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? `${n}` : `${parseFloat(n.toFixed(1))}`;
};
const fmtWeight = (w, unit) => `${fmt(w)}${unit}`;

function calcWeeklyStreak(history) {
  if (!history.length) return 0;
  const startOfWeek = (d) => {
    const x = new Date(d);
    const day = x.getDay() || 7;
    x.setDate(x.getDate() - day + 1);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  const weeks = new Set(history.map(w => startOfWeek(w.startedAt)));
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
function recommendNextSet(lastSet, allSetsThisExercise, settings) {
  const { weight, reps, failure, form } = lastSet;
  const { targetMin, targetMax, targetIdeal, increment, unit } = settings;
  const e1rm = epley1RM(weight, reps);

  // Bad form override — biggest cut, ignore other factors
  if (form === 'bad') {
    const next = roundIncrement(weight * 0.85, increment);
    return {
      weight: next,
      repRange: [targetMin, targetMax],
      targetReps: targetIdeal,
      reason: `Form broke down on that set. Cutting load to ${fmtWeight(next, unit)} so the next set is technically clean.`,
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
    reason = `${fmtWeight(weight, unit)} × ${reps} is too heavy for hypertrophy. Dropping to land you in the ${targetMin}–${targetMax} range.`;
  } else if (reps === 6) {
    baseWeight = weight * 0.95;
    tag = 'adjust';
    targetReps = targetIdeal;
    reason = `6 reps is just under the band. Small drop to bring you back inside ${targetMin}–${targetMax}.`;
  } else if (reps >= targetMin && reps <= targetMax) {
    if (failure) {
      baseWeight = weight; // fatigue cut applied below
      // Target slightly lower reps as fatigue accumulates
      targetReps = Math.max(targetMin, Math.min(reps, reps - Math.floor(priorFailureSets / 2)));
      reason = `${reps} reps to failure was on target. Slight cut for fatigue keeps the next set in the band.`;
    } else {
      baseWeight = weight;
      tag = 'push';
      targetReps = Math.min(targetMax, reps + 2);
      reason = `${reps} reps but not at failure — repeat the load and push closer to the limit.`;
    }
  } else {
    // reps > targetMax
    baseWeight = weightForReps(e1rm, targetIdeal);
    if (baseWeight <= weight) baseWeight = weight + increment;
    tag = 'progress';
    targetReps = targetIdeal;
    reason = `${reps} reps means the load was light. Bumping up to bring you back to ${targetMin}–${targetMax}.`;
  }

  // Apply fatigue discount only when last set was failure
  const finalWeight = roundIncrement(
    baseWeight * (failure ? fatigueDiscount : 1),
    increment
  );

  return {
    weight: finalWeight,
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
  return history
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

  // Recommend an extra back-off set
  const e1rm = epley1RM(last.weight, last.reps);
  const baseWeight = weightForReps(e1rm, settings.targetIdeal);
  // Heavier fatigue cut for the 4th+ working set
  const fatigueDiscount = Math.max(0.85, 1 - 0.025 * rescueState.workingCount);
  const weight = roundIncrement(baseWeight * fatigueDiscount, settings.increment);

  return {
    tag: 'rescue-extra',
    weight,
    repRange: [settings.targetMin, settings.targetMax],
    targetReps: null,
    reason: `Volume still ${fmt(Math.round(rescueState.volumeDeficit))}${settings.unit} short of last session. One extra back-off set at ${fmt(weight)}${settings.unit} for ${settings.targetMin}+ reps closes the gap and banks the win.`,
    e1rm,
  };
}

function getWorkoutRecommendation(exercise, history, settings) {
  const rescueState = computeRescueState(exercise, history, settings);
  const lastWorking = rescueState.lastWorkingSet;

  // No working sets yet → opening recommendation (PR push if history exists)
  if (!lastWorking) {
    return { rec: recommendOpeningSet(exercise.name, history, settings), rescueState };
  }

  // Rescue active and 3+ working sets done → check for extra set or stop signal
  if (rescueState.active && rescueState.workingCount >= RESCUE_STANDARD_SET_COUNT) {
    const decision = decideExtraRescueSet(rescueState, settings);
    if (decision) return { rec: decision, rescueState };
  }

  // Standard adaptive recommendation
  const rec = recommendNextSet(lastWorking, exercise.sets, settings);

  // Overlay rescue framing
  if (rescueState.active) {
    if (rescueState.workingCount === 1) {
      // Set 2: this is the recommendation right after the trigger set
      return {
        rec: {
          ...rec,
          tag: 'rescue',
          targetReps: null, // show the range, not a "+N" target
          reason: `${rescueState.triggerReason} Another heavy attempt isn't useful — chasing progress through back-off hypertrophy volume instead.`,
        },
        rescueState,
      };
    }
    return {
      rec: { ...rec, tag: 'rescue', targetReps: null },
      rescueState,
    };
  }

  return { rec, rescueState };
}

// ============================================================
// STORAGE
// ============================================================
// Synchronous localStorage adapter. Payload is tiny (a few KB even with
// hundreds of sessions) so JSON-stringify on every write is fine. If the
// dataset ever grows past ~5MB we'd want to migrate to IndexedDB.
const storage = {
  get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  },
  del(key) {
    try { localStorage.removeItem(key); } catch {}
  },
};

// ============================================================
// FONTS & GLOBAL STYLES
// ============================================================
function FontStyles() {
  useEffect(() => {
    const id = 'hypercoach-fonts';
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Anton&family=Sora:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap';
    document.head.appendChild(link);
  }, []);
  return (
    <style>{`
      .font-display { font-family: 'Anton', 'Impact', sans-serif; letter-spacing: 0.02em; }
      .font-body { font-family: 'Sora', system-ui, sans-serif; }
      .font-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
      .scrollbar-hide::-webkit-scrollbar { display: none; }
      .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
      input[type=number]::-webkit-inner-spin-button,
      input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
      input[type=number] { -moz-appearance: textfield; }
      @keyframes pulse-ring {
        0% { box-shadow: 0 0 0 0 rgba(249, 115, 22, 0.4); }
        70% { box-shadow: 0 0 0 12px rgba(249, 115, 22, 0); }
        100% { box-shadow: 0 0 0 0 rgba(249, 115, 22, 0); }
      }
      .pulse-ring { animation: pulse-ring 2s infinite; }
      @keyframes slide-up {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .slide-up { animation: slide-up 0.3s ease-out; }
    `}</style>
  );
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

function Stepper({ value, onChange, step, min = 0, max = 9999, decimals = 0, large = false }) {
  const dec = () => onChange(Math.max(min, parseFloat((value - step).toFixed(2))));
  const inc = () => onChange(Math.min(max, parseFloat((value + step).toFixed(2))));
  return (
    <div className="flex items-stretch gap-1.5 w-full">
      <button
        onClick={dec}
        className="w-10 flex-shrink-0 bg-neutral-800 hover:bg-neutral-700 active:bg-neutral-600 rounded-lg flex items-center justify-center text-neutral-300"
      >
        <Minus size={18} strokeWidth={2.5} />
      </button>
      <input
        type="number"
        inputMode="decimal"
        value={value}
        step={step}
        onChange={e => {
          const v = parseFloat(e.target.value);
          if (!isNaN(v)) onChange(v);
          else onChange(0);
        }}
        className={`min-w-0 flex-1 w-full bg-neutral-900 border border-neutral-800 rounded-lg text-center text-white font-mono font-bold px-1 ${large ? 'text-2xl py-2' : 'text-lg py-1.5'}`}
      />
      <button
        onClick={inc}
        className="w-10 flex-shrink-0 bg-neutral-800 hover:bg-neutral-700 active:bg-neutral-600 rounded-lg flex items-center justify-center text-neutral-300"
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
function HomeScreen({ history, onStart, onOpenExercise, settings, install, onShowInstall }) {
  const streak = useMemo(() => calcWeeklyStreak(history), [history]);
  const lastWorkout = history[history.length - 1];

  // Show install hint once per device unless dismissed. We don't pester desktop
  // users — the value of installing is much higher on phones.
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
    [...history].reverse().forEach(w => {
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
      .filter(w => w.startedAt >= weekAgo)
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
              <div className="text-[11px] text-neutral-400 mt-0.5">Add to home screen — works offline.</div>
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
  onLogSet, onDeleteSet, onAddExercise, onFinishExercise, onFinishWorkout, onBack,
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
    const w = roundIncrement(workingRec.weight * 0.5, settings.increment);
    return {
      weight: w,
      repRange: [5, 8],
      targetReps: 5,
      reason: `Half of today's planned working weight (${workingRec.weight}${settings.unit}). Primes the movement without eating into your working set strength.`,
      e1rm: 0,
      tag: 'warmup',
    };
  }, [workingRec, lastWorkingSet, settings]);

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
    if (weight <= 0 || reps <= 0) return;
    onLogSet({
      weight,
      reps,
      // Warm-ups are never "to failure" and never have form judged for the recommendation engine
      failure: setType === 'warmup' ? false : failure,
      form: setType === 'warmup' ? 'good' : form,
      type: setType,
      notes: notes.trim() || undefined,
      timestamp: Date.now(),
    });
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
            <Stepper value={reps} onChange={v => setReps(Math.round(v))} step={1} min={1} max={100} large />
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
function HistoryScreen({ history, settings, onDeleteWorkout }) {
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
            {[...history].reverse().map(w => {
              const workingSets = w.exercises.flatMap(e => e.sets.filter(s => s.type === 'working'));
              const totalSets = workingSets.length;
              const totalVol = workingSets.reduce((s, x) => s + x.weight * x.reps, 0);
              return (
                <div key={w.id} className="bg-neutral-900 border border-neutral-800 rounded-lg p-3">
                  <div className="flex items-start justify-between mb-2 gap-2">
                    <div className="text-sm text-white">{new Date(w.startedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <div className="text-[10px] uppercase tracking-widest font-mono text-neutral-500">
                        {totalSets} sets · {fmt(Math.round(totalVol))}{settings.unit}
                      </div>
                      <button
                        onClick={() => onDeleteWorkout(w)}
                        aria-label="Delete workout"
                        className="p-1.5 -mr-1 text-neutral-600 hover:text-red-400 active:text-red-500"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <div className="text-xs text-neutral-400">
                    {w.exercises.map(e => e.name).join(' · ')}
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
// SETTINGS SCREEN
// ============================================================
function SettingsScreen({ settings, onChange, history, onReset, onExport, install, onShowInstall }) {
  const update = (k, v) => onChange({ ...settings, [k]: v });

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
              Adds HyperCoach to your home screen for full-screen, offline use.
            </div>
          </Section>
        )}
        {install.isStandalone && (
          <Section label="App Install">
            <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3.5 flex items-center gap-3">
              <CheckCircle2 size={18} className="text-lime-400 flex-shrink-0" />
              <div className="text-sm text-neutral-300">Installed and running standalone.</div>
            </div>
          </Section>
        )}

        <Section label="Units">
          <div className="flex gap-2">
            <Pill active={settings.unit === 'kg'} onClick={() => update('unit', 'kg')}>kg</Pill>
            <Pill active={settings.unit === 'lbs'} onClick={() => update('unit', 'lbs')}>lbs</Pill>
          </div>
        </Section>

        <Section label="Weight Increment">
          <div className="grid grid-cols-4 gap-2">
            {(settings.unit === 'kg' ? [1, 1.25, 2.5, 5] : [1, 2.5, 5, 10]).map(v => (
              <Pill key={v} active={settings.increment === v} onClick={() => update('increment', v)}>
                {v}{settings.unit}
              </Pill>
            ))}
          </div>
        </Section>

        <Section label={`Target Rep Range (${settings.targetMin}–${settings.targetMax})`}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5 px-1">Min</div>
              <Stepper value={settings.targetMin} onChange={v => update('targetMin', Math.round(v))} step={1} min={1} max={settings.targetMax - 1} />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5 px-1">Max</div>
              <Stepper value={settings.targetMax} onChange={v => update('targetMax', Math.round(v))} step={1} min={settings.targetMin + 1} max={30} />
            </div>
          </div>
        </Section>

        <Section label={`Ideal Target Reps (${settings.targetIdeal})`}>
          <Stepper value={settings.targetIdeal} onChange={v => update('targetIdeal', Math.round(v))} step={1} min={settings.targetMin} max={settings.targetMax} />
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
  const install = useInstallPrompt();

  // Load
  useEffect(() => {
    const h = storage.get(STORAGE_KEYS.history);
    const s = storage.get(STORAGE_KEYS.settings);
    if (Array.isArray(h)) setHistory(h);
    if (s) setSettings({ ...DEFAULT_SETTINGS, ...s });
    setLoaded(true);
  }, []);

  // Persist
  useEffect(() => { if (loaded) storage.set(STORAGE_KEYS.history, history); }, [history, loaded]);
  useEffect(() => { if (loaded) storage.set(STORAGE_KEYS.settings, settings); }, [settings, loaded]);

  const startWorkout = () => {
    setWorkout({ id: `w_${Date.now()}`, startedAt: Date.now(), exercises: [] });
    setScreen('exercise-select');
  };

  const startWorkoutWith = (name) => {
    const w = { id: `w_${Date.now()}`, startedAt: Date.now(), exercises: [{ name, sets: [] }] };
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

  const finishWorkout = () => {
    if (!workout) return;
    const valid = {
      ...workout,
      exercises: workout.exercises.filter(e => e.sets.length > 0),
      completedAt: Date.now(),
    };
    if (valid.exercises.length === 0) {
      // discard
      setWorkout(null);
      setScreen('home');
      return;
    }
    setHistorySnapshotForSummary(history);
    setCompletedWorkout(valid);
    setHistory([...history, valid]);
    setWorkout(null);
    setScreen('summary');
  };

  const handleAddExercise = () => setScreen('exercise-select');

  const handleBackFromSelect = () => {
    if (workout && workout.exercises.length > 0) {
      setScreen('workout');
    } else {
      setWorkout(null);
      setScreen('home');
    }
  };

  const handleBackFromWorkout = () => {
    setConfirm({
      title: 'Pause workout?',
      body: 'Your sets so far will be kept. You can finish from the workout screen.',
      confirmLabel: 'Go Home',
      onConfirm: () => {
        // Save in-progress workout into history? For simplicity we discard the in-progress one.
        // Better behavior: keep it as resumable. For now, finish if any sets logged, else discard.
        const hasSets = workout && workout.exercises.some(e => e.sets.length > 0);
        if (hasSets) {
          finishWorkout();
        } else {
          setWorkout(null);
          setScreen('home');
        }
        setConfirm(null);
      },
      onCancel: () => setConfirm(null),
    });
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

  const inWorkout = screen === 'workout' || screen === 'exercise-select' || screen === 'summary';

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
            onShowInstall={() => setShowInstall(true)}
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
          <HistoryScreen history={history} settings={settings} onDeleteWorkout={deleteWorkout} />
        )}
        {screen === 'settings' && (
          <SettingsScreen
            settings={settings}
            onChange={setSettings}
            history={history}
            onReset={handleReset}
            onExport={handleExport}
            install={install}
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
