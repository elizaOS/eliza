import type { TraceSpan } from '@evilmartians/agent-prism-types';

import { Check, Copy } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import JSONPretty from 'react-json-pretty';
import colors from 'tailwindcss/colors';

import { CollapsibleSection } from '../CollapsibleSection';
import { IconButton } from '../IconButton';
import { Tabs, type TabItem } from '../Tabs';

interface DetailsViewInputOutputTabProps {
  data: TraceSpan;
}

type IOTab = 'json' | 'plain';

type IOSection = 'Input' | 'Output';

export const DetailsViewInputOutputTab = ({
  data,
}: DetailsViewInputOutputTabProps): ReactElement => {
  const hasInput = Boolean(data.input);
  const hasOutput = Boolean(data.output);

  if (!hasInput && !hasOutput) {
    return (
      <div className="p-6 text-center">
        <p className="text-muted-foreground ">No input or output data available for this span.</p>
      </div>
    );
  }

  let parsedInput: string | null = null;
  let parsedOutput: string | null = null;

  if (typeof data.input === 'string') {
    try {
      parsedInput = JSON.parse(data.input);
    } catch {
      parsedInput = null;
    }
  }

  if (typeof data.output === 'string') {
    try {
      parsedOutput = JSON.parse(data.output);
    } catch {
      parsedOutput = null;
    }
  }

  return (
    <div className="space-y-3">
      {typeof data.input === 'string' && (
        <IOSection section="Input" content={data.input} parsedContent={parsedInput} />
      )}

      {typeof data.output === 'string' && (
        <IOSection section="Output" content={data.output} parsedContent={parsedOutput} />
      )}
    </div>
  );
};

interface IOSectionProps {
  section: IOSection;
  content: string;
  parsedContent: string | null;
}

const IOSection = ({ section, content, parsedContent }: IOSectionProps): ReactElement => {
  const [tab, setTab] = useState<IOTab>('plain');
  const [open, setOpen] = useState(true);

  const tabItems: TabItem<IOTab>[] = [
    {
      value: 'json',
      label: 'JSON',
      disabled: !parsedContent,
    },
    {
      value: 'plain',
      label: 'Plain',
    },
  ];

  return (
    <CollapsibleSection
      title={section}
      defaultOpen
      onOpenChange={setOpen}
      rightContent={
        open ? (
          <Tabs<IOTab>
            items={tabItems}
            defaultValue="plain"
            value={tab}
            onValueChange={setTab}
            theme="pill"
            onClick={(event) => event.stopPropagation()}
          />
        ) : null
      }
      triggerClassName="min-h-16"
    >
      <IOContent content={content} section={section} tab={tab} parsedContent={parsedContent} />
    </CollapsibleSection>
  );
};

interface IOContentProps extends Omit<IOSectionProps, 'title'> {
  tab: IOTab;
  parsedContent: string | null;
}

const IOContent = ({ tab, content, section, parsedContent }: IOContentProps): ReactElement => {
  if (!content) {
    return <p className="p-3 text-sm italic text-muted-foreground ">No data available</p>;
  }

  return (
    <div className="relative rounded-lg border border-border ">
      <CopyButton section={section} content={content} />

      {tab === 'json' && (
        <>
          {parsedContent ? (
            <JSONPretty
              booleanStyle="color: hsl(var(--primary));"
              className="overflow-x-auto rounded-xl p-4 text-left"
              data={parsedContent}
              id={`json-pretty-${section}`}
              keyStyle="color: hsl(var(--primary));"
              mainStyle="color: hsl(var(--muted-foreground)); font-size: 12px;"
              stringStyle="color: hsl(var(--chart-2));"
              valueStyle="color: hsl(var(--chart-1));"
            />
          ) : (
            <div className="p-4 text-sm text-muted-foreground">Invalid JSON format</div>
          )}
        </>
      )}

      {tab === 'plain' && (
        <div className="rounded-lg bg-muted/50 p-4">
          <pre className="overflow-x-auto whitespace-pre-wrap text-left font-mono text-xs text-foreground">
            {content}
          </pre>
        </div>
      )}
    </div>
  );
};

type CopyButtonProps = {
  section: IOSection;
  content: string;
};

const CopyButton = ({ section, content }: CopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);

  const onClick = () => {
    navigator.clipboard.writeText(content);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  return (
    <IconButton
      onClick={onClick}
      aria-label={isCopied ? `${section} Data Copied` : `Copy ${section} Data`}
      variant="ghost"
      className="absolute right-1.5 top-1.5"
    >
      {isCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </IconButton>
  );
};
