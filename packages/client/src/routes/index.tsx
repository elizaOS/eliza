import { createBrowserRouter, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import App from '../App';

// Lazy load components
const Chat = lazy(() => import('../routes/chat'));
const Group = lazy(() => import('../routes/group'));
const GroupNew = lazy(() => import('../routes/group-new'));
const AgentList = lazy(() => import('../routes/agent-list'));
const AgentDetail = lazy(() => import('../routes/agent-detail'));
const CharacterList = lazy(() => import('../routes/character-list'));
const CharacterForm = lazy(() => import('../routes/character-form'));
const CharacterDetail = lazy(() => import('../routes/character-detail'));
// const Settings = lazy(() => import('../routes/settings')); // Settings route for individual agent to be removed
const EnvSettings = lazy(() => import('../components/env-settings')); // Lazy import for EnvSettings
const NotFound = lazy(() => import('../routes/not-found'));

// Loading fallback
const Loading = () => (
  <div className="flex items-center justify-center h-full">
    <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
  </div>
);

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      {
        path: '/',
        element: <Navigate to="/" />,
      },
      {
        path: '/agents',
        element: (
          <Suspense fallback={<Loading />}>
            <AgentList />
          </Suspense>
        ),
      },
      {
        path: '/agents/:agentId',
        element: (
          <Suspense fallback={<Loading />}>
            <AgentDetail />
          </Suspense>
        ),
      },
      {
        path: '/chat/:agentId',
        element: (
          <Suspense fallback={<Loading />}>
            <Chat />
          </Suspense>
        ),
      },
      {
        path: '/chat/:agentId/:roomId',
        element: (
          <Suspense fallback={<Loading />}>
            <Chat />
          </Suspense>
        ),
      },
      {
        path: '/group/new',
        element: (
          <Suspense fallback={<Loading />}>
            <GroupNew />
          </Suspense>
        ),
      },
      {
        path: '/group/:channelId',
        element: (
          <Suspense fallback={<Loading />}>
            <Group />
          </Suspense>
        ),
      },
      {
        path: '/characters',
        element: (
          <Suspense fallback={<Loading />}>
            <CharacterList />
          </Suspense>
        ),
      },
      {
        path: '/characters/new',
        element: (
          <Suspense fallback={<Loading />}>
            <CharacterForm />
          </Suspense>
        ),
      },
      {
        path: '/characters/:characterId',
        element: (
          <Suspense fallback={<Loading />}>
            <CharacterDetail />
          </Suspense>
        ),
      },
      {
        path: '/characters/:characterId/edit',
        element: (
          <Suspense fallback={<Loading />}>
            <CharacterForm />
          </Suspense>
        ),
      },
      {
        path: '/settings', // General settings route
        element: (
          <Suspense fallback={<Loading />}>
            <EnvSettings />
          </Suspense>
        ),
      },
      {
        path: '*',
        element: (
          <Suspense fallback={<Loading />}>
            <NotFound />
          </Suspense>
        ),
      },
    ],
  },
]);
