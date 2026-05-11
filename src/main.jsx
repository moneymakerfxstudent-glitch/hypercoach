import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './HyperCoach.jsx';
import './index.css';

// vite-plugin-pwa exposes a virtual module that registers the service
// worker and handles the autoUpdate lifecycle (skipWaiting + reload).
// We import for side effect — registration starts as soon as this runs.
//
// In dev mode this import is a no-op (devOptions.enabled is false in the
// vite config), so we don't need to gate it.
import { registerSW } from 'virtual:pwa-register';

registerSW({
  immediate: true,
  // onRegisteredSW / onNeedRefresh / onOfflineReady are no-ops here because
  // we use registerType: 'autoUpdate' in the vite config. The SW handles
  // updates silently — the user's next page load picks up the new build.
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
