import React from 'react';

export default function Loader() {
  return (
    <div className="py-12 w-full flex flex-col items-center gap-2 animate-pulse select-none">
      <img
        src="/logos/degen.png"
        width="128"
        height="128"
        className="size-12 mx-auto"
        alt="degen"
      />
      <span className="text-sm">Loading</span>
    </div>
  );
}
