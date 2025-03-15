import React from 'react';
import clsx from 'clsx';
import { X } from 'lucide-react';
import {TagList, Tags, type TagType} from '../../../../data/users';
import styles from './styles.module.css';

function ShowcaseTagSelect({
  tag,
  label,
  color,
  description,
  selected,
  onToggle,
}: {
  tag: TagType;
  label: string;
  color: string;
  description: string;
  selected: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <li className={styles.tagListItem}>
      <button
        className={clsx(styles.tagButton, {
          [styles.tagButtonSelected]: selected,
        })}
        onClick={onToggle}
        style={{
          backgroundColor: selected ? color : 'transparent',
          borderColor: color,
          color: selected ? '#fff' : 'inherit',
        }}
        title={description}
      >
        {label}
      </button>
    </li>
  );
}

export default function ShowcaseFilters({
  selectedTags,
  toggleTag,
  operator,
  toggleOperator,
}: {
  selectedTags: TagType[];
  toggleTag: (tag: TagType) => void;
  operator: 'AND' | 'OR';
  toggleOperator: () => void;
}): JSX.Element {
  const clearAllFilters = () => {
    // Clear all selected tags by toggling each one that's currently selected
    selectedTags.forEach(tag => toggleTag(tag));
  };

  const hasActiveFilters = selectedTags.length > 0;

  return (
    <>
      <div className={styles.filtersWrapper}>
        <div className={styles.filterHeader}>
          <h3 className={styles.filterTitle}>Filters</h3>
          
          <div className={styles.operatorToggle}>
            <span>Combine:</span>
            <button
              className={clsx(styles.operatorSwitch, {
                [styles.operatorSwitchAnd]: operator === 'AND'
              })}
              onClick={toggleOperator}
              title={operator === 'OR' ? 'Change to AND (all filters must match)' : 'Change to OR (any filter can match)'}
            >
              <span className={styles.switchKnob}></span>
              <span className={styles.switchLabel}>AND</span>
            </button>
          </div>
          
          <button 
            className={styles.clearButton}
            onClick={clearAllFilters}
            disabled={!hasActiveFilters}
            aria-label="Clear all filters"
            title="Clear all filters"
          >
            <X size={14} />
            Clear
          </button>
        </div>
      </div>

      <ul className={clsx('clean-list', styles.tagList)}>
        {TagList.filter(tag => tag).map((tag) => {
          const {label, description, color} = Tags[tag];
          return (
            <ShowcaseTagSelect
              key={tag}
              tag={tag}
              label={label}
              color={color}
              description={description}
              selected={selectedTags.includes(tag)}
              onToggle={() => toggleTag(tag)}
            />
          );
        })}
      </ul>
    </>
  );
}
