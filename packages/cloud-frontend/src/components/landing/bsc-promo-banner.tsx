import { Link } from "react-router-dom";

export default function BscPromoBanner() {
  return (
    <Link
      to="/bsc"
      className="fixed top-0 left-0 z-[101] block w-full bg-yellow-400 px-4 py-2 text-center text-xs font-semibold text-black hover:bg-yellow-300 sm:text-sm"
    >
      <span className="font-bold">BSC PROMOTION LIVE.</span> Buy $10 or more
      credit with BSC, receive an additional $5!
    </Link>
  );
}
