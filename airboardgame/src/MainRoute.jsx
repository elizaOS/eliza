import React from "react";

import {
  Route,
  Routes,
  Navigate,
  useParams,
  useLocation,
} from "react-router-dom";

import "react-toastify/dist/ReactToastify.css";
import "./react-confirm-alert.css";

import { uid } from "./utils";
import Home from "./views/Home";
import GameView from "./views/GameView";
import Session from "./views/Session";
import AuthView from "./views/AuthView";
import RoomView from "./views/RoomView";

import { Provider as SocketIOProvider } from "@scripters/use-socket.io";

import { SOCKET_URL, SOCKET_OPTIONS } from "./utils/settings";

const WithSocketIO = ({ children }) => (
  <SocketIOProvider url={SOCKET_URL} options={SOCKET_OPTIONS}>
    {children}
  </SocketIOProvider>
);

const RedirectToSession = () => {
  const { gameId } = useParams();
  return (
    <Navigate
      to={`/session/${uid()}/`}
      replace
      state={{
        fromGame: gameId,
      }}
    />
  );
};

const RedirectToVassalSession = () => {
  return <Navigate to={`/vassal-session/${uid()}/`} replace />;
};

const StartSession = ({ isVassalSession }) => {
  const { sessionId } = useParams();
  const { state } = useLocation();
  return (
    <WithSocketIO>
      <Session
        sessionId={sessionId}
        fromGame={state ? state.fromGame : null}
        isVassalSession={isVassalSession}
      />
    </WithSocketIO>
  );
};

const StartStudio = () => {
  const { gameId } = useParams();
  return (
    <WithSocketIO>
      <GameView gameId={gameId} />
    </WithSocketIO>
  );
};

const StartRoom = () => {
  const { roomId } = useParams();
  return (
    <WithSocketIO>
      <RoomView roomId={roomId} />
    </WithSocketIO>
  );
};

const RedirectToRoom = () => {
  return (
    <Navigate to={`/room/${uid()}/`} replace state={{ showInvite: true }} />
  );
};

const CompatOldSession = () => {
  const { gameId, sessionId } = useParams();

  return (
    <Navigate
      to={`/session/${sessionId ? sessionId : uid()}/`}
      replace
      state={{
        fromGame: gameId,
      }}
    />
  );
};

const MainRoute = () => {
  return (
    <Routes>
      {/* for compat with old url scheme */}
      <Route path="/game/:gameId/session/" element={<CompatOldSession />} />
      {/* for compat with old url scheme */}
      <Route
        path="/game/:gameId/session/:sessionId/"
        element={<CompatOldSession />}
      />
      {/* Start a new session from this game */}
      <Route path="/playgame/:gameId" element={<RedirectToSession />} />
      <Route path="/session/:sessionId" element={<StartSession />} />
      <Route path="/playvassalgame/" element={<RedirectToVassalSession />} />
      <Route
        path="/vassal-session/:sessionId"
        element={<StartSession isVassalSession={true} />}
      />
      {/* Game edition */}
      <Route path="/game/:gameId?/*" element={<StartStudio />} />
      {/*Room routes*/}
      <Route path="/room/:roomId/*" element={<StartRoom />} />
      <Route path="/room/" element={<RedirectToRoom />} />
      {/* Auth rout */}
      <Route path="/login/:userHash/:token" element={<AuthView />} />
      {/* Default route */}
      <Route path="/" element={<Navigate to="/games/" />} />
      <Route path="/*" element={<Home />} />
    </Routes>
  );
};

export default MainRoute;
