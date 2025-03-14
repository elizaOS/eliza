import {useState, useCallback} from 'react';
import {type TagType, type User, sortedUsers} from '../../data/users';

// Hook for managing selected tags
export function useFilteredUsers() {
  const [selectedTags, setSelectedTags] = useState<TagType[]>([]);
  const [operator, setOperator] = useState<'AND' | 'OR'>('OR');

  const toggleTag = useCallback((tag: TagType) => {
    setSelectedTags(tags => 
      tags.includes(tag) 
        ? tags.filter(t => t !== tag)
        : [...tags, tag]
    );
  }, []);

  const toggleOperator = useCallback(() => {
    setOperator(op => op === 'OR' ? 'AND' : 'OR');
  }, []);

  // Filter users based on selected tags
  const filteredUsers = selectedTags.length === 0 
    ? sortedUsers 
    : sortedUsers.filter(user => {
        if (operator === 'AND') {
          return selectedTags.every(tag => user.tags.includes(tag));
        } else {
          return selectedTags.some(tag => user.tags.includes(tag));
        }
      });

  return {
    selectedTags,
    toggleTag,
    operator,
    toggleOperator,
    filteredUsers,
  };
}
