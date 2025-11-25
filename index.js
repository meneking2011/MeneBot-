import React from "react";
import ReactDOM from "react-dom/client"; // Use modern ReactDOM client
import App from "./App.jsx";

// Standard entry point to render the App component into the HTML DOM.
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);