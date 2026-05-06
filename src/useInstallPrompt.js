import { useEffect, useState, useCallback } from 'react';

// Detects whether the app is running in a PWA standalone window.
// iOS uses the legacy `navigator.standalone` flag; everywhere else uses the
// display-mode media query.
function detectStandalone() {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  if (window.navigator.standalone === true) return true; // iOS
  return false;
}

function detectPlatform() {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports as Mac with touch points — catch that too.
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1);
  if (isIOS) return 'ios';
  if (/android/i.test(ua)) return 'android';
  return 'desktop';
}

// Centralised install state. Components consume this via useInstallPrompt.
export function useInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [isStandalone, setIsStandalone] = useState(detectStandalone());
  const [platform] = useState(detectPlatform());

  useEffect(() => {
    // Chrome/Edge/Android fire this event when the page is install-eligible.
    // We capture it so we can trigger the native prompt at a moment of our
    // choosing rather than letting the browser show its own UI.
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

    // Also listen for display-mode changes — if the user installs and opens
    // in standalone, we want to reflect that immediately.
    const mq = window.matchMedia?.('(display-mode: standalone)');
    const onChange = () => setIsStandalone(detectStandalone());
    mq?.addEventListener?.('change', onChange);

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
    platform,                    // 'ios' | 'android' | 'desktop' | 'unknown'
    isStandalone,                // already installed and running standalone?
    canPromptInstall: !!deferredPrompt, // native prompt available right now?
    promptInstall,               // async — triggers the native prompt
  };
}
