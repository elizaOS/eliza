import { useState, useRef, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, X } from 'lucide-react';
import { formatAgentName } from '@/lib/utils';

interface Option {
  icon: string;
  label: string;
}

interface MultiSelectComboboxProps {
  options: Option[];
  className?: string;
  onSelect?: (selected: Option[]) => void;
}

export default function MultiSelectCombobox({
  options = [],
  className = '',
  onSelect,
}: MultiSelectComboboxProps) {
  const [selected, setSelected] = useState<Option[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const comboboxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (comboboxRef.current && !comboboxRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleSelection = (option: Option) => {
    setSelected((prev) => {
      const newSelection = prev.some((item) => item.label === option.label)
        ? prev.filter((item) => item.label !== option.label)
        : [...prev, option];
      if (onSelect) onSelect(newSelection);
      return newSelection;
    });
  };

  const removeSelection = (option: Option) => {
    setSelected((prev) => {
      const newSelection = prev.filter((item) => item.label !== option.label);
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
        className={`flex items-center gap-2 border p-2 bg-transparent rounded cursor-pointer ${isOpen ? 'border-gray-300' : 'border-input'}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex flex-wrap gap-1 w-full">
          {selected.length > 0 ? (
            <>
              {selected.slice(0, 3).map((item, index) => (
                <Badge key={index} className="flex items-center gap-1 px-2">
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
            <span className="text-gray-500">Select options...</span>
          )}
        </div>
        <ChevronDown size={16} />
      </div>
      {isOpen && (
        <Card className="absolute left-0 mt-2 w-full shadow-md border border-gray-500 rounded z-40 max-h-60 overflow-y-auto">
          {options.map((option, index) => (
            <div
              key={index}
              className={`flex items-center gap-2 p-2 cursor-pointer rounded ${
                selected.some((item) => item.label === option.label) ? 'bg-muted' : 'bg-card'
              }`}
              onClick={() => toggleSelection(option)}
            >
              <div className="bg-gray-500 rounded-full w-4 h-4 flex justify-center items-center overflow-hidden text-xs">
                {option.icon ? (
                  <img src={option.icon} alt={option.label} className="w-full h-full" />
                ) : (
                  formatAgentName(option.label)
                )}
              </div>
              {option.label}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
