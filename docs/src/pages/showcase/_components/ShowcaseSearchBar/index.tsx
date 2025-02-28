import React, { useCallback } from 'react';
import { debounce } from 'lodash';
import { Search } from 'lucide-react';
import styles from './styles.module.css';

export default function ShowcaseSearchBar({
  onChange,
  value
}: {
  onChange: (value: string) => void;
  value: string;
}): JSX.Element {
  // Debounce the onChange callback
  const debouncedOnChange = useCallback(
    debounce((newValue: string) => {
      onChange(newValue);
    }, 200),
    [onChange]
  );

  return (
    <div className={styles.searchContainer}>
      <div className={styles.searchInputWrapper}>
        <Search size={18} className={styles.searchIcon} />
        <input
          type="text"
          placeholder="Search packages..."
          className={styles.searchInput}
          defaultValue={value}
          onChange={(e) => debouncedOnChange(e.target.value)}
          aria-label="Search packages"
        />
        {value && (
          <button 
            className={styles.clearButton}
            onClick={() => onChange('')}
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
