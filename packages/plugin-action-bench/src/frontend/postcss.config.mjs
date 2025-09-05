/** @type {import('postcss-load-config').Config} */
import autoprefixer from 'autoprefixer';
import tailwindcss from 'tailwindcss';

const config = {
  plugins: [
    tailwindcss(),
    autoprefixer(),
  ],
};

export default config;
