/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"],
  theme: {
    extend: {
      colors: {
        ink: "#1f2933",
        moss: "#315c45",
        brick: "#a6422f",
        paper: "#faf8f3"
      }
    }
  },
  plugins: [import("@tailwindcss/typography")]
};
