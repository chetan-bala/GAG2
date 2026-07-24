/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./pages/**/*.{js,jsx}", "./components/**/*.{js,jsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        surface: "#13161c",
        border: "#1e2230",
        muted: "#7b8299",
        seed: "#10b981",
        gear: "#0ea5e9",
        crate: "#f97316",
      },
    },
  },
  plugins: [],
}
