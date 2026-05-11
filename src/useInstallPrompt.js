import { useEffect, useState, useCallback } from 'react';

// =============================================================
// Standalone / platform detection
// =============================================================

function detectStandalone() {
  if (typeof window === 'undefined') return false;
  // Modern API (Android, desktop)
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  // iOS legacy flag — still required, manifest doesn't cover this on iOS
  if (window.navigator.standalone === true) return true;
  return false;
}

function detectPlatform() {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports as Mac with touch points — catch that case too,
  // otherwise iPad users get the wrong install instructions.
  const isIOS = /iPhone|iPad|iPod/.test(ua) ||
    (ua.includes('Mac') && navigator.maxTouchPoints > 1);
  if (isIOS) return 'ios';
  if (/android/i.test(ua)) return 'android';
  return 'desktop';
}

// =============================================================
// Persistent storage request
// =============================================================
//
// iOS evicts script-writable storage (localStorage, IndexedDB, Cache) after
// ~7 days of non-use, AND has a hard cap (~50MB historically, larger on
// Safari 17+). Calling navigator.storage.persist() asks the browser to
// exempt this origin from automatic eviction.
//
// On iOS the request is granted automatically once the user adds the PWA
// to the Home Screen (no permission prompt). On Android/desktop it may
// require a notification permission first; we don't push for it.
//
// We call this once on app load and surface the result so the user can see
// in Settings whether their data is durable.

async function requestPersistentStorage() {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
    return { supported: false, persisted: false };
  }
  try {
    const already = await navigator.storage.persisted?.();
    if (already) return { supported: true, persisted: true };
    const granted = await navigator.storage.persist();
    return { supported: true, persisted: !!granted };
  } catch {
    return { supported: true, persisted: false };
  }
}

async function estimateStorage() {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return null;
  }
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  } catch {
    return null;
  }
}

// =============================================================
// Hook: useInstallPrompt
// =============================================================

export function useInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [isStandalone, setIsStandalone] = useState(detectStandalone());
  const [platform] = useState(detectPlatform());
  const [persisted, setPersisted] = useState(null);
  const [storageInfo, setStorageInfo] = useState(null);

  useEffect(() => {
    // Chrome/Edge/Android fire beforeinstallprompt when the app is
    // install-eligible. We capture it so we can trigger the native prompt
    // at our own moment of choosing rather than letting the browser
    // show its own banner.
    const onBIP = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    const onInstalled = () => {
      setDeferredPrompt(null);
      setIsStandalone(true);
    };

    window.addEventListener('beforeinstallprompt', onBIP);
    window.addEventListener('appinstalled', onInstalled);

    // Listen for display-mode flips so launching from Home Screen updates
    // the install banner state immediately.
    const mq = window.matchMedia?.('(display-mode: standalone)');
    const onChange = () => setIsStandalone(detectStandalone());
    mq?.addEventListener?.('change', onChange);

    // Request persistent storage. Async, doesn't block the UI.
    requestPersistentStorage().then(setPersisted);
    estimateStorage().then(setStorageInfo);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBIP);
      window.removeEventListener('appinstalled', onInstalled);
      mq?.removeEventListener?.('change', onChange);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) return { outcome: 'unavailable' };
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    return choice;
  }, [deferredPrompt]);

  return {
    platform,                        // 'ios' | 'android' | 'desktop' | 'unknown'
    isStandalone,                    // launched from home screen?
    canPromptInstall: !!deferredPrompt,
    promptInstall,
    persisted,                       // { supported, persisted } | null while loading
    storageInfo,                     // { usage, quota } | null
  };
}
