import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActionCard } from '../action-viewer';

// Minimal mock log with state
const mockLog = {
  id: '1',
  body: {
    modelType: 'TEST',
    state: { values: { foo: 'bar' }, data: {}, text: 'foo bar' },
  },
  createdAt: Date.now(),
};

describe('ActionCard', () => {
  it('renders state when provided', () => {
    render(<ActionCard action={mockLog} />);
    // Expand state section
    const trigger = screen.getByText('State');
    fireEvent.click(trigger);
    expect(screen.getByText(/foo bar/)).toBeTruthy();
  });
});
