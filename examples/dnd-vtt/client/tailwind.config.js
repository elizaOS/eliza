/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        parchment: {
          50: '#fdfbf7',
          100: '#f8f4ea',
          200: '#f0e6d3',
          300: '#e4d4b5',
          400: '#d4bc91',
          500: '#c4a373',
          600: '#b38d5c',
          700: '#96734c',
          800: '#7a5e42',
          900: '#654e38',
        },
        blood: {
          500: '#8b0000',
          600: '#700000',
          700: '#550000',
        },
        gold: {
          400: '#ffd700',
          500: '#daa520',
          600: '#b8860b',
        },
      },
      fontFamily: {
        fantasy: ['Cinzel', 'serif'],
        body: ['Crimson Text', 'Georgia', 'serif'],
      },
      boxShadow: {
        'inner-lg': 'inset 0 2px 15px 0 rgb(0 0 0 / 0.15)',
        parchment: '0 4px 6px -1px rgb(0 0 0 / 0.3), 0 2px 4px -2px rgb(0 0 0 / 0.2)',
      },
    },
  },
  plugins: [],
};
