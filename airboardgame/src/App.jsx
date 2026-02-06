import React, { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "react-query";

import { BrowserRouter as Router } from "react-router-dom";

import { RecoilRoot } from "recoil";
import { ToastContainer } from "react-toastify";

import "react-toastify/dist/ReactToastify.css";
import "./react-confirm-alert.css";

import Waiter from "./ui/Waiter";
import { FullScreenProvider } from "./hooks/useFullScreen";

import MainRoute from "./MainRoute";

const queryClient = new QueryClient();

const App = () => {
  return (
    <FullScreenProvider>
      <Suspense fallback={<Waiter />}>
        <RecoilRoot>
          <QueryClientProvider client={queryClient}>
            <Router>
              <MainRoute />
            </Router>
          </QueryClientProvider>
        </RecoilRoot>
        <ToastContainer
          position="top-center"
          autoClose={3000}
          hideProgressBar={false}
          newestOnTop
          closeOnClick
          rtl={false}
          pauseOnFocusLoss
          draggable
          pauseOnHover
        />
        <div id="panel-container" />
        <div id="modal-container" />
      </Suspense>
    </FullScreenProvider>
  );
};

export default App;
