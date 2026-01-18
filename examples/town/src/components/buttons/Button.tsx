import clsx from 'clsx';
import { MouseEventHandler, ReactNode } from 'react';

export default function Button(props: {
  className?: string;
  href?: string;
  imgUrl: string;
  onClick?: MouseEventHandler;
  title?: string;
  children: ReactNode;
}) {
  return (
    <a
      className={clsx(
        'button text-white shadow-solid text-xl pointer-events-auto',
        props.className,
      )}
      href={props.href}
      title={props.title}
      onClick={props.onClick}
    >
      <div className="inline-block bg-clay-700">
        <span>
          <div className="inline-flex h-full items-center gap-4">
            <img className="w-4 h-4 sm:w-[30px] sm:h-[30px]" src={props.imgUrl} />
            {props.children}
          </div>
        </span>
      </div>
    </a>
  );
}
