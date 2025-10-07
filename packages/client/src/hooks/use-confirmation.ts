import { useState, useCallback } from 'react';
import ConfirmationDialog from '@/components/confirmation-dialog';

interface ConfirmationOptions {
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'destructive';
}

export function useConfirmation() {
  const [confirmationState, setConfirmationState] = useState<{
    open: boolean;
    options: ConfirmationOptions | null;
    onConfirm: (() => void) | null;
  }>({
    open: false,
    options: null,
    onConfirm: null,
  });

  const confirm = useCallback((options: ConfirmationOptions, onConfirm: () => void) => {
    setConfirmationState({
      open: true,
      options,
      onConfirm,
    });
  }, []);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setConfirmationState({
        open: false,
        options: null,
        onConfirm: null,
      });
    }
  }, []);

  const handleConfirm = useCallback(() => {
    if (confirmationState.onConfirm) {
      confirmationState.onConfirm();
    }
    handleOpenChange(false);
  }, [confirmationState.onConfirm, handleOpenChange]);

  return {
    confirm,
    isOpen: confirmationState.open,
    onOpenChange: handleOpenChange,
    onConfirm: handleConfirm,
    options: confirmationState.options,
  };
}
