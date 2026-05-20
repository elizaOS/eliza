'use client';

import { cn } from '@feed/shared';
import { Image as ImageIcon, X } from 'lucide-react';
import { toast } from 'sonner';

interface BugReportFieldsProps {
  stepsToReproduce: string;
  onStepsChange: (value: string) => void;
  screenshotPreview: string | null;
  onScreenshotChange: (file: File | null, preview: string | null) => void;
}

export function BugReportFields({
  stepsToReproduce,
  onStepsChange,
  screenshotPreview,
  onScreenshotChange,
}: BugReportFieldsProps) {
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image size must be less than 10MB');
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => {
      toast.error('Failed to read the image file');
    };
    reader.onloadend = () => {
      onScreenshotChange(file, reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveScreenshot = () => {
    onScreenshotChange(null, null);
  };

  return (
    <>
      {/* Steps to Reproduce */}
      <div className="space-y-2">
        <label
          htmlFor="stepsToReproduce"
          className="font-medium text-foreground text-sm"
        >
          Steps to Reproduce <span className="text-destructive">*</span>
        </label>
        <textarea
          id="stepsToReproduce"
          value={stepsToReproduce}
          onChange={(e) => onStepsChange(e.target.value)}
          placeholder="1. Go to...&#10;2. Click on...&#10;3. See error..."
          maxLength={2000}
          rows={5}
          className={cn(
            'w-full rounded-lg border border-border bg-muted px-3 py-2',
            'text-foreground placeholder-muted-foreground',
            'focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#1c9cf0]',
            'resize-none transition-colors'
          )}
        />
        <div className="flex justify-between text-muted-foreground text-xs">
          <span>Maximum 2000 characters</span>
          <span>{stepsToReproduce.length}/2000</span>
        </div>
      </div>

      {/* Screenshot Upload */}
      <div className="space-y-2">
        <label className="font-medium text-foreground text-sm">
          Screenshot (optional)
        </label>
        {screenshotPreview ? (
          <div className="relative">
            <img
              src={screenshotPreview}
              alt="Screenshot preview"
              className="max-h-64 w-full rounded-lg border border-border object-contain"
            />
            <button
              type="button"
              onClick={handleRemoveScreenshot}
              className="absolute top-2 right-2 rounded-full bg-destructive p-2 text-primary-foreground transition-colors hover:bg-destructive/90"
              aria-label="Remove screenshot"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <label
            htmlFor="screenshot"
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-border border-dashed bg-muted/30 p-6',
              'transition-colors hover:border-[#1c9cf0] hover:bg-muted/50'
            )}
          >
            <ImageIcon className="h-8 w-8 text-muted-foreground" />
            <span className="text-muted-foreground text-sm">
              Click to upload a screenshot
            </span>
            <span className="text-muted-foreground text-xs">
              PNG, JPG, or GIF (max 10MB)
            </span>
            <input
              id="screenshot"
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />
          </label>
        )}
      </div>
    </>
  );
}
