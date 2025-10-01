export type SpanCardConnectorType =
  | 'horizontal'
  | 'vertical'
  | 't-right'
  | 'corner-top-right'
  | 'empty';

interface SpanCardConnectorProps {
  type: SpanCardConnectorType;
}

export const SpanCardConnector = ({ type }: SpanCardConnectorProps) => {
  if (type === 'empty') return <div className="w-5 shrink-0 grow" />;

  return (
    <div className="relative w-5 shrink-0 grow">
      {(type === 'vertical' || type === 't-right') && (
        <div className="absolute bottom-0 left-1/2 top-0 w-0.5 -translate-x-1/2 bg-muted" />
      )}

      {type === 't-right' && (
        <div className="absolute left-2.5 top-2.5 h-0.5 w-2.5 -translate-y-[3px] bg-muted" />
      )}

      {type === 'corner-top-right' && (
        <>
          <div className="absolute left-1/2 top-2 size-0.5 -translate-x-1/2 -translate-y-px bg-muted" />

          <div className="absolute left-1/2 top-2.5 h-0.5 w-2.5 -translate-y-[3px] bg-muted" />

          <div className="absolute left-1/2 top-0 h-[7px] w-0.5 -translate-x-px bg-muted" />
        </>
      )}
    </div>
  );
};
