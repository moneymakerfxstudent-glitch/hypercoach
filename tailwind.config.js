/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // System font stack — guaranteed available, zero network needed.
        // SF Pro on iOS gives a clean premium feel that suits a gym app.
        body: [
          '-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"',
          '"Helvetica Neue"', 'Helvetica', 'Arial', 'system-ui', 'sans-serif',
        ],
        // For numbers / data — SF Mono on iOS, fallbacks elsewhere.
        mono: [
          'ui-monospace', '"SF Mono"', 'Menlo', 'Monaco', 'Consolas',
          '"Liberation Mono"', '"Courier New"', 'monospace',
        ],
        // Display headings — system condensed where available, otherwise
        // we fake it with stretch + heavy weight + tight tracking in CSS.
        display: [
          '"SF Pro Display"', '-apple-system', 'BlinkMacSystemFont',
          '"Helvetica Neue Condensed"', '"Arial Narrow"', 'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};
