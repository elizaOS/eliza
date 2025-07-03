import { Button } from '@/components/ui/button';
import type { Agent } from '@elizaos/core';
import { Image as ImageIcon, Upload, X, Info } from 'lucide-react';
import { useRef, useState, useEffect } from 'react';
import { compressImage } from '@/lib/utils';
import { AVATAR_IMAGE_MAX_SIZE } from '@/constants';

interface AvatarPanelProps {
  characterValue: Agent;
  setCharacterValue: {
    updateAvatar?: (avatarUrl: string) => void;
    updateSetting?: <T>(path: string, value: T) => void;
    updateField?: <T>(path: string, value: T) => void;
    [key: string]: any;
  };
}

export default function AvatarPanel({ characterValue, setCharacterValue }: AvatarPanelProps) {
  const [avatar, setAvatar] = useState<string | null>(characterValue?.settings?.avatar || null);
  const [hasChanged, setHasChanged] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset the change flag when component initializes or character changes
  useEffect(() => {
    setAvatar(characterValue?.settings?.avatar || null);
    setHasChanged(false);
  }, [characterValue.id]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      try {
        const compressedImage = await compressImage(file);
        setAvatar(compressedImage);
        setHasChanged(true);

        // Only update when there's a real change
        updateCharacterAvatar(compressedImage);
      } catch (error) {
        console.error('Error compressing image:', error);
      }
    }
  };

  const handleRemoveAvatar = () => {
    if (avatar) {
      setAvatar(null);
      setHasChanged(true);
      updateCharacterAvatar('');
    }
  };

  // Centralized update function to avoid code duplication
  const updateCharacterAvatar = (avatarUrl: string) => {
    if (setCharacterValue.updateAvatar) {
      // Use the specialized method for avatar updates when available
      setCharacterValue.updateAvatar(avatarUrl);
    } else if (setCharacterValue.updateSetting) {
      // Use updateSetting as fallback
      setCharacterValue.updateSetting('avatar', avatarUrl);
    } else if (setCharacterValue.updateField) {
      // Last resort - use the generic field update
      setCharacterValue.updateField('settings.avatar', avatarUrl);
    }
  };

  return (
    <div className="rounded-lg w-full">
      <h2 className="text-xl font-bold mb-4 pb-5 ml-1">Avatar Settings</h2>

      <div className="flex flex-col items-center gap-4 pb-4 max-w-sm mx-auto">
        {/* Image preview area */}
        {avatar ? (
          <div className="w-64 h-64 mb-2">
            <img
              src={avatar}
              alt="Agent Avatar"
              className="object-cover w-full h-full rounded-lg border"
            />
          </div>
        ) : (
          <div
            className="w-64 h-64 flex items-center justify-center border border-dashed rounded-lg text-gray-500 mb-2 cursor-pointer hover:bg-gray-50 transition-colors"
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="flex flex-col items-center gap-2">
              <ImageIcon className="w-10 h-10" />
              <span className="text-sm">Click to upload</span>
            </div>
          </div>
        )}

        {/* Controls area */}
        <div className="flex flex-col gap-3 w-64">
          <input
            type="file"
            accept="image/*"
            className="hidden"
            ref={fileInputRef}
            onChange={handleFileUpload}
          />

          <div className="flex gap-2">
            <Button
              type="button"
              className="flex items-center gap-2 flex-1"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="w-5 h-5" />
              {avatar ? 'Replace' : 'Upload'}
            </Button>

            {avatar && (
              <Button
                type="button"
                variant="outline"
                className="flex items-center"
                onClick={handleRemoveAvatar}
              >
                <X className="w-5 h-5" />
              </Button>
            )}
          </div>

          <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground mt-1">
            <Info className="w-3.5 h-3.5" />
            <span>
              Images greater than {AVATAR_IMAGE_MAX_SIZE}x{AVATAR_IMAGE_MAX_SIZE} will be resized
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
