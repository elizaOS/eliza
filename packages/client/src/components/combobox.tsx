import { useState, useRef, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, X } from 'lucide-react';
import { formatAgentName } from '@/lib/utils';

interface Option {
  icon: string;
  label: string;
  id?: string;
}

interface MultiSelectComboboxProps {
  options: Option[];
  className?: string;
  onSelect?: (selected: Option[]) => void;
  initialSelected?: Option[];
}

export default function MultiSelectCombobox({
  options = [],
  className = '',
  onSelect,
  initialSelected = [],
}: MultiSelectComboboxProps) {
  const [selected, setSelected] = useState<Option[]>(initialSelected);
  const [isOpen, setIsOpen] = useState(false);
  const comboboxRef = useRef<HTMLDivElement>(null);

  // Apply initialSelected when it changes - improved to handle both initial load and updates
  useEffect(() => {
    setSelected(initialSelected);
  }, [initialSelected]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (comboboxRef.current && !comboboxRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Helper function to compare options using id if available, fallback to label
  const isOptionSelected = (option: Option): boolean => {
    return selected.some((item) => {
      if (option.id && item.id) {
        return item.id === option.id;
      }
      return item.label === option.label;
    });
  };

  // Helper function to find option in selected array
  const findSelectedOption = (option: Option): Option | undefined => {
    return selected.find((item) => {
      if (option.id && item.id) {
        return item.id === option.id;
      }
      return item.label === option.label;
    });
  };

  const toggleSelection = (option: Option) => {
    console.log('[MultiSelectCombobox] toggleSelection called with:', option);
    setSelected((prev) => {
      const isCurrentlySelected = isOptionSelected(option);
      let newSelection: Option[];

      if (isCurrentlySelected) {
        // Remove the option
        newSelection = prev.filter((item) => {
          if (option.id && item.id) {
            return item.id !== option.id;
          }
          return item.label !== option.label;
        });
      } else {
        // Add the option
        newSelection = [...prev, option];
      }

      console.log('[MultiSelectCombobox] New selection:', newSelection);
      if (onSelect) onSelect(newSelection);
      return newSelection;
    });
  };

  const removeSelection = (option: Option) => {
    setSelected((prev) => {
      const newSelection = prev.filter((item) => {
        if (option.id && item.id) {
          return item.id !== option.id;
        }
        return item.label !== option.label;
      });
      if (onSelect) onSelect(newSelection);
      return newSelection;
    });
  };

  const removeExtraSelections = () => {
    setSelected((prev) => {
      const newSelection = prev.slice(0, 3); // Keep only the first 3
      if (onSelect) onSelect(newSelection);
      return newSelection;
    });
  };

  return (
    <div className={`relative w-80 ${className}`} ref={comboboxRef}>
      <div
        className={`flex items-center gap-2 border p-2 bg-background rounded cursor-pointer ${isOpen ? 'border-primary' : 'border-input'}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex flex-wrap gap-1 w-full">
          {selected.length > 0 ? (
            <>
              {selected.slice(0, 3).map((item, index) => (
                <Badge
                  key={item.id || item.label || index}
                  className="flex items-center gap-1 px-2"
                >
                  {item.label}
                  <X
                    size={12}
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeSelection(item);
                    }}
                  />
                </Badge>
              ))}
              {selected.length > 3 && (
                <Badge
                  className="px-2 cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeExtraSelections();
                  }}
                >
                  +{selected.length - 3} more
                </Badge>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">Select agents...</span>
          )}
        </div>
        <ChevronDown size={16} />
      </div>
      {isOpen && (
        <Card className="absolute left-0 mt-2 w-full shadow-md border border-border rounded z-40 max-h-60 overflow-y-auto">
          {options.length === 0 ? (
            <div className="p-2 text-muted-foreground text-sm">No agents available</div>
          ) : (
            options.map((option, index) => (
              <div
                key={option.id || option.label || index}
                className={`flex items-center gap-2 p-2 cursor-pointer rounded hover:bg-muted ${
                  isOptionSelected(option) ? 'bg-muted' : 'bg-card'
                }`}
                onClick={() => toggleSelection(option)}
              >
                <div className="bg-gray-500 rounded-full w-4 h-4 flex justify-center items-center overflow-hidden text-xs">
                  {option.icon ? (
                    <img
                      src={option.icon}
                      alt={option.label}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    formatAgentName(option.label)
                  )}
                </div>
                {option.label}
              </div>
            ))
          )}
        </Card>
      )}
    </div>
  );
}
