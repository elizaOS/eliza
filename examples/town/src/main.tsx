import React from 'react';
import ReactDOM from 'react-dom/client';
import './pixi/extendPixi';
import Home from './App.tsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Home />
  </React.StrictMode>,
);
