// MeneBot/Frontend/frontend/src/main.jsx

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx'; // Imports your main application component
import './index.css'; // Imports the Tailwind CSS directives

// Finds the root div in index.html and renders the App component inside it
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);