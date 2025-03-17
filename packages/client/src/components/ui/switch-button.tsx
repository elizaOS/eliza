import * as React from 'react';
import { cn } from '@/lib/utils';

export interface SwitchProps {
  checked: boolean;
  onChange: () => void;
  className?: string;
}

const Switch: React.FC<SwitchProps> = ({ checked, onChange, className }) => {
  return (
    <div
      className={cn(
        'flex items-center h-6 w-11 rounded-full cursor-pointer transition-colors',
        checked ? 'bg-gray-500' : 'bg-card',
        className
      )}
      onClick={onChange}
    >
      <div
        className={cn(
          'w-4 h-4 bg-white rounded-full transform transition-transform',
          checked ? 'translate-x-6' : 'translate-x-1'
        )}
      ></div>
    </div>
  );
};

export { Switch };
