//  @ts-check

/** @type {import('prettier').Config} */
const config = {
  trailingComma: "all",
  tabWidth: 2,
  printWidth: 80,
  plugins: [
    "prettier-plugin-tailwindcss",
    "prettier-plugin-classnames",
    "prettier-plugin-merge",
  ],
};

export default config;
