import { Button } from "@/components/ui/button";
import type { Agent } from "@elizaos/core";
import { Upload, Image as ImageIcon, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface ThumbnailPanelProps {
  characterValue: Agent;
  setCharacterValue: (value: (prev: Agent) => Agent) => void;
}

export default function ThumbnailPanel({
  characterValue,
  setCharacterValue,
}: ThumbnailPanelProps) {
  const [thumbnail, setThumbnail] = useState<string | null>(
    characterValue?.thumbnail || null
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
	const file = event.target.files?.[0];
	if (file) {
	  const reader = new FileReader();
	  reader.onload = (e) => {
		if (e.target?.result) {
		  const img = new Image();
		  img.src = e.target.result as string;
		  img.onload = () => {
			const canvas = document.createElement("canvas");
			const maxSize = 300; // Resize to max 300px width/height
			let width = img.width;
			let height = img.height;
  
			if (width > height) {
			  if (width > maxSize) {
				height *= maxSize / width;
				width = maxSize;
			  }
			} else {
			  if (height > maxSize) {
				width *= maxSize / height;
				height = maxSize;
			  }
			}
  
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			ctx?.drawImage(img, 0, 0, width, height);
			const resizedBase64 = canvas.toDataURL("image/jpeg", 0.8); // Reduce quality to 80%
  
			setThumbnail(resizedBase64);
		  };
		}
	  };
	  reader.readAsDataURL(file);
	}
  };
  

  useEffect(() => {
    setCharacterValue((prev) => ({
      ...prev,
      thumbnail: thumbnail,
    }));
  }, [thumbnail, setCharacterValue]);

  return (
    <div className="rounded-lg w-full">
      <h2 className="text-xl font-bold mb-4 pb-5 ml-1">Thumbnail Settings</h2>

      <div className="flex flex-col items-center gap-4 pb-4">
        {thumbnail ? (
          <div className="relative">
            <img
              src={thumbnail}
              alt="Character Thumbnail"
              className="w-64 h-64 object-cover rounded-lg border"
            />
            <button
              className="absolute -top-2 -right-2 bg-white p-1 rounded-full shadow-md"
              onClick={() => setThumbnail(null)}
            >
              <X className="w-5 h-5 text-red-500" />
            </button>
          </div>
        ) : (
          <div className="w-32 h-32 flex items-center justify-center border border-dashed rounded-lg text-gray-500">
            <ImageIcon className="w-10 h-10" />
          </div>
        )}

        <input
          type="file"
          accept="image/*"
          className="hidden"
          ref={fileInputRef}
          onChange={handleFileUpload}
        />
        <Button
          className="flex items-center gap-2"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="w-5 h-5" /> Upload Thumbnail
        </Button>
      </div>
    </div>
  );
}
