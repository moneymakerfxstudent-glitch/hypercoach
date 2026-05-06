import { Share, Plus, MoreVertical, Download, ChevronDown, X } from 'lucide-react';

// Visual step list for installing the PWA. Selected based on platform.
//
// iOS Safari: no programmatic install. User must use Share → Add to Home Screen.
// Android Chrome: we usually have a deferred prompt and trigger it directly,
//   but if the user dismissed it or used a different browser, fall back to
//   the manual three-dot-menu route.
// Desktop: Chrome/Edge support an install action in the address bar.

function StepRow({ n, icon: Icon, children }) {
  return (
    <div className="flex gap-3 items-start py-2">
      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-orange-500 text-black font-bold text-sm flex items-center justify-center">
        {n}
      </div>
      <div className="flex-1 text-sm text-neutral-200 leading-relaxed pt-0.5 flex items-center gap-2">
        {children}
        {Icon && <Icon size={16} className="text-neutral-400 flex-shrink-0" />}
      </div>
    </div>
  );
}

function IOSInstructions() {
  return (
    <div>
      <div className="text-xs uppercase tracking-widest text-neutral-500 mb-3">iPhone / iPad · Safari</div>
      <StepRow n={1}>
        Open this page in <span className="font-bold text-white">Safari</span> (not Chrome — iOS only allows installs from Safari).
      </StepRow>
      <StepRow n={2} icon={Share}>
        Tap the <span className="font-bold text-white">Share</span> icon at the bottom of the screen.
      </StepRow>
      <StepRow n={3} icon={Plus}>
        Scroll down and tap <span className="font-bold text-white">Add to Home Screen</span>.
      </StepRow>
      <StepRow n={4}>
        Tap <span className="font-bold text-white">Add</span> in the top-right corner. The app icon appears on your home screen.
      </StepRow>
    </div>
  );
}

function AndroidInstructions({ canPrompt, onInstall }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-widest text-neutral-500 mb-3">Android · Chrome</div>
      {canPrompt ? (
        <>
          <div className="text-sm text-neutral-300 mb-3">
            Your browser supports one-tap install. Hit the button below.
          </div>
          <button
            onClick={onInstall}
            className="w-full bg-orange-500 hover:bg-orange-400 active:bg-orange-600 text-black font-bold uppercase tracking-wider py-4 rounded-lg flex items-center justify-center gap-2 mb-4"
          >
            <Download size={18} strokeWidth={2.5} />
            Install HyperCoach
          </button>
          <div className="text-xs text-neutral-500 mb-2">Or do it manually:</div>
        </>
      ) : null}
      <StepRow n={1} icon={MoreVertical}>
        Tap the <span className="font-bold text-white">three-dot menu</span> in Chrome's top-right.
      </StepRow>
      <StepRow n={2}>
        Tap <span className="font-bold text-white">Install app</span> or <span className="font-bold text-white">Add to Home screen</span>.
      </StepRow>
      <StepRow n={3}>
        Confirm <span className="font-bold text-white">Install</span>. The app icon appears in your launcher.
      </StepRow>
    </div>
  );
}

function DesktopInstructions({ canPrompt, onInstall }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-widest text-neutral-500 mb-3">Desktop · Chrome / Edge</div>
      {canPrompt && (
        <>
          <button
            onClick={onInstall}
            className="w-full bg-orange-500 hover:bg-orange-400 active:bg-orange-600 text-black font-bold uppercase tracking-wider py-4 rounded-lg flex items-center justify-center gap-2 mb-4"
          >
            <Download size={18} strokeWidth={2.5} />
            Install HyperCoach
          </button>
          <div className="text-xs text-neutral-500 mb-2">Or do it manually:</div>
        </>
      )}
      <StepRow n={1} icon={Download}>
        Look for the <span className="font-bold text-white">install icon</span> on the right of the address bar.
      </StepRow>
      <StepRow n={2}>
        Click it, then click <span className="font-bold text-white">Install</span>.
      </StepRow>
    </div>
  );
}

export function InstallModal({ open, onClose, platform, canPromptInstall, onPromptInstall }) {
  if (!open) return null;
  const handleInstall = async () => {
    const result = await onPromptInstall();
    if (result?.outcome === 'accepted') onClose();
  };
  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-xl p-5 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-1">
          <div className="font-display text-2xl text-white uppercase">Install HyperCoach</div>
          <button onClick={onClose} className="text-neutral-500 hover:text-white -mr-1 p-1">
            <X size={20} />
          </button>
        </div>
        <div className="text-sm text-neutral-400 mb-5">
          Add to your home screen for full-screen, offline-ready training.
        </div>

        {platform === 'ios' && <IOSInstructions />}
        {platform === 'android' && (
          <AndroidInstructions canPrompt={canPromptInstall} onInstall={handleInstall} />
        )}
        {(platform === 'desktop' || platform === 'unknown') && (
          <DesktopInstructions canPrompt={canPromptInstall} onInstall={handleInstall} />
        )}

        <div className="text-xs text-neutral-500 mt-5 pt-4 border-t border-neutral-800">
          All workout data stays on your device. No account, no sync, no servers.
        </div>
      </div>
    </div>
  );
}
