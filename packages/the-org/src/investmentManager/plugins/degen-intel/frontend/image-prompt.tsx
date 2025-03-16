import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import Loader from './loader';
import { Button } from './ui/button';
import { Input } from './ui/input';

export default function ImagePrompt() {
  const [prompt, setPrompt] = useState<string>('');

  const mutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(`${import.meta.env.VITE_API_URL}/image-prompt`, {
        method: 'POST',
        headers: {
          Accept: '*/*',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prompt }),
      });
      const buffer = await response.arrayBuffer();
      const blob = new Blob([buffer]);
      const url = URL.createObjectURL(blob);
      return url;
    },
    mutationKey: ['image_prompt'],
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Enter image prompt"
          value={prompt}
          onChange={({ target }) => setPrompt(target.value)}
        />
        <Button disabled={mutation?.isPending} onClick={() => mutation.mutate()}>
          Send
        </Button>
      </div>
      {mutation?.isPending ? <Loader /> : null}
      {mutation?.data ? (
        <img
          src={mutation?.data}
          width={750}
          height={750}
          className="mx-auto max-w-full"
          alt="degen"
        />
      ) : null}
    </div>
  );
}
