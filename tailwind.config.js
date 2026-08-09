/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0E1114",       // base background
        panel: "#161A1F",     // card/panel surface
        line: "#262B32",      // hairline borders
        ember: "#E8A33D",     // primary accent (ticker amber)
        rise: "#3DDC84",      // buy / running / positive
        fall: "#E5484D",      // stop / error / negative
        mute: "#7A828C",      // secondary text
        paper: "#EDEFF2",     // primary text
      },
      fontFamily: {
        display: ["'Space Grotesk'", "sans-serif"],
        mono: ["'JetBrains Mono'", "monospace"],
      },
    },
  },
  plugins: [],
}
