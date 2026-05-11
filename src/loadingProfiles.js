// ============================================================
// LOADING PROFILES
// ============================================================
//
// A loading profile describes the discrete set of weights actually available
// for a given exercise. The recommendation engine computes an "ideal"
// theoretical weight, then this module snaps it to the nearest real weight
// the user can actually load.
//
// Profile types:
//   fixed     — linear increments (e.g. 2.5kg steps)
//   dumbbell  — paired dumbbells in fixed jumps (e.g. 2kg)
//   plate     — barbell + plates per side
//   stack     — manually-entered machine stack (e.g. 17, 22, 27, 32...)
//   custom    — arbitrary list (decimals, Matrix machines, etc)
//
// All profiles resolve to a sorted weights[] array; rounding is identical
// across types. This keeps the engine integration simple.

export const DEFAULT_PROFILE = {
  type: 'fixed',
  increment: 2.5,
  min: 0,
  max: 500,
};

export const PROFILE_TYPES = ['fixed', 'dumbbell', 'plate', 'stack', 'custom'];

// Generate the available-weights list for a given profile.
// Memoization isn't critical here — lists are short and rebuilt per
// recommendation. Returns a sorted ascending array of numbers.
export function availableWeights(profile) {
  if (!profile) profile = DEFAULT_PROFILE;
  const min = Number.isFinite(profile.min) ? profile.min : 0;
  const max = Number.isFinite(profile.max) ? profile.max : 500;

  switch (profile.type) {
    case 'fixed': {
      const inc = profile.increment > 0 ? profile.increment : 2.5;
      const out = [];
      // Start from a multiple of `inc` >= min, walk up to max.
      const start = Math.ceil(min / inc) * inc;
      for (let w = start; w <= max + 1e-9; w += inc) {
        out.push(roundTo(w, 4));
      }
      return out;
    }

    case 'dumbbell': {
      // Dumbbells come in pairs but the displayed weight is per-dumbbell.
      // We just need the per-dumbbell increment.
      const inc = profile.increment > 0 ? profile.increment : 2;
      const out = [];
      const start = Math.max(min, inc);
      for (let w = start; w <= max + 1e-9; w += inc) {
        out.push(roundTo(w, 4));
      }
      return out;
    }

    case 'plate': {
      // Barbell + plates per side. Total weight = bar + 2 * (plates loaded).
      // We generate every reachable sum using each plate up to its count.
      const bar = profile.barWeight ?? 20;
      const plates = (profile.plates || []).filter(p => p.weight > 0 && p.count > 0);
      if (!plates.length) {
        // Bar only.
        return [bar];
      }
      // BFS over plate combinations, capped at max.
      const reached = new Set([0]);
      for (const p of plates) {
        const next = new Set(reached);
        for (const v of reached) {
          for (let n = 1; n <= p.count; n++) {
            const total = v + n * p.weight;
            if (total * 2 + bar > max + 1e-9) break;
            next.add(roundTo(total, 4));
          }
        }
        for (const v of next) reached.add(v);
      }
      const out = [];
      for (const sidePlates of reached) {
        const total = bar + 2 * sidePlates;
        if (total >= min - 1e-9 && total <= max + 1e-9) {
          out.push(roundTo(total, 4));
        }
      }
      return Array.from(new Set(out)).sort((a, b) => a - b);
    }

    case 'stack':
    case 'custom': {
      // Manually-entered list of available weights.
      const list = (profile.weights || [])
        .map(Number)
        .filter(w => Number.isFinite(w) && w >= min && w <= max);
      return Array.from(new Set(list)).sort((a, b) => a - b);
    }

    default:
      return availableWeights(DEFAULT_PROFILE);
  }
}

// Round `target` to the closest weight in `weights[]` per the direction:
//   'down'    → highest weight ≤ target (else lowest available)
//   'up'      → lowest weight ≥ target (else highest available)
//   'nearest' → whichever is closer
//
// `weights` MUST be a sorted ascending array of unique numbers. Use
// availableWeights() to produce it.
export function snapToList(target, weights, direction = 'nearest') {
  if (!weights || !weights.length) return target;
  if (!Number.isFinite(target)) return weights[0];

  // Binary search for the insertion point
  let lo = 0, hi = weights.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (weights[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  // lo is the first index whose weight is >= target

  const lower = lo > 0 ? weights[lo - 1] : null;
  const upper = lo < weights.length ? weights[lo] : null;

  if (direction === 'down') {
    if (lower !== null) return lower;
    return upper; // nothing lower; return the smallest
  }
  if (direction === 'up') {
    if (upper !== null) return upper;
    return lower; // nothing higher; return the biggest
  }
  // nearest
  if (lower === null) return upper;
  if (upper === null) return lower;
  return Math.abs(upper - target) < Math.abs(target - lower) ? upper : lower;
}

// Convenience — takes a profile, returns the snapped weight.
export function roundToAvailable(target, profile, direction = 'nearest') {
  const list = availableWeights(profile);
  return snapToList(target, list, direction);
}

// Map a recommendation engine tag to a rounding direction.
// The engine produces tags like 'too-heavy', 'on-track', 'push', etc.
// This is how the loading profile knows which way to round.
export function directionForTag(tag) {
  switch (tag) {
    case 'too-heavy':
    case 'reset':
    case 'adjust':
    case 'rescue':
    case 'rescue-extra':
      return 'down';
    case 'push':
    case 'progress':
      return 'up';
    case 'warmup':
    case 'on-track':
    case 'calibrate':
    default:
      return 'nearest';
  }
}

// Resolve which profile applies for a given exercise. Per-exercise overrides
// win; otherwise we fall back to the user's global default.
export function profileForExercise(exerciseName, settings) {
  const overrides = settings?.exerciseProfiles || {};
  return overrides[exerciseName] || settings?.defaultProfile || DEFAULT_PROFILE;
}

function roundTo(n, decimals) {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

// Human-readable description of a profile for UI display.
export function describeProfile(profile, unit = 'kg') {
  if (!profile) return 'Default';
  switch (profile.type) {
    case 'fixed':
      return `Fixed ${profile.increment}${unit} increments`;
    case 'dumbbell':
      return `Dumbbells ${profile.increment}${unit} steps`;
    case 'plate': {
      const bar = profile.barWeight ?? 20;
      const plateCount = (profile.plates || []).reduce((s, p) => s + (p.count || 0), 0);
      return `Bar ${bar}${unit} + ${plateCount} plates`;
    }
    case 'stack':
      return `Stack · ${(profile.weights || []).length} positions`;
    case 'custom':
      return `Custom · ${(profile.weights || []).length} weights`;
    default:
      return 'Unknown';
  }
}
