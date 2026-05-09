import { Tweet as ReactTweet } from "react-tweet";

interface TweetProps {
  id: string;
}

export default function Tweet({ id }: TweetProps) {
  return (
    <div
      className="my-6 flex justify-center not-prose hue-rotate-15 contrast-[1.15]"
      data-theme="dark"
    >
      <ReactTweet id={id} />
    </div>
  );
}
