import "./wdyr";

import React from "react";
import ReactDOM from "react-dom/client";

import "./sentry";

import "./index.css";

import "./i18n"; // load translation system

import App from "./App";
import * as serviceWorker from "./serviceWorker";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// If you want your app to work offline and load faster, you can change
// unregister() to register() below. Note this comes with some pitfalls.
// Learn more about service workers: https://bit.ly/CRA-PWA
serviceWorker.unregister();
