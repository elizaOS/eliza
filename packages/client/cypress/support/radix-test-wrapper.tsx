import React from 'react';
import { DirectionProvider } from '@radix-ui/react-direction';

interface RadixTestWrapperProps {
  children: React.ReactNode;
}

export const RadixTestWrapper: React.FC<RadixTestWrapperProps> = ({ children }) => {
  return (
    <DirectionProvider dir="ltr">
      <div id="radix-root" style={{ width: '100%', height: '100%' }}>
        {children}
      </div>
    </DirectionProvider>
  );
};
