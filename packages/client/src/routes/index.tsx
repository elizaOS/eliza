import { createBrowserRouter } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import App from '../App';

// Lazy load components
const Chat = lazy(() => import('../components/chat'));

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
        element: (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            Select an agent to start chatting
          </div>
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
        path: '/logs',
        element: (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            Logs feature coming soon
          </div>
        ),
      },
    ],
  },
]);
