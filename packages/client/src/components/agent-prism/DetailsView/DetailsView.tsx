import type { TraceSpan } from '@evilmartians/agent-prism-types';

import { cn } from '@/lib/utils';
import { SquareTerminal, Tags, ArrowRightLeft } from 'lucide-react';
import { useState, type ReactElement, type ReactNode } from 'react';

import type { AvatarProps } from '../Avatar';

import { Tabs, type TabItem } from '../Tabs';
import { DetailsViewAttributesTab } from './DetailsViewAttributesTab';
import { DetailsViewHeader } from './DetailsViewHeader';
import { DetailsViewInputOutputTab } from './DetailsViewInputOutputTab';
import { DetailsViewMetrics } from './DetailsViewMetrics';
import { DetailsViewRawDataTab } from './DetailsViewRawDataTab';

type DetailsViewTab = 'input-output' | 'attributes' | 'raw';

export interface DetailsViewProps {
  /**
   * The span data to display in the details view
   */
  data: TraceSpan;

  /**
   * Optional avatar configuration for the header
   */
  avatar?: AvatarProps;

  /**
   * The initially selected tab
   */
  defaultTab?: DetailsViewTab;

  /**
   * Optional className for the root container
   */
  className?: string;

  /**
   * Configuration for the copy button functionality
   */
  copyButton?: {
    isEnabled?: boolean;
    onCopy?: (data: TraceSpan) => void;
  };

  /**
   * Custom header actions to render
   * Can be a ReactNode or a render function that receives the data
   */
  headerActions?: ReactNode | ((data: TraceSpan) => ReactNode);

  /**
   * Optional custom header component to replace the default
   */
  customHeader?: ReactNode | ((props: { data: TraceSpan }) => ReactNode);

  /**
   * Callback fired when the active tab changes
   */
  onTabChange?: (tabValue: DetailsViewTab) => void;
}

export const DetailsView = ({
  data,
  avatar,
  defaultTab,
  className,
  copyButton,
  headerActions,
  customHeader,
  onTabChange,
}: DetailsViewProps): ReactElement => {
  const [tab, setTab] = useState<DetailsViewTab>(defaultTab || 'input-output');

  const tabItems: TabItem<DetailsViewTab>[] = [
    {
      value: 'input-output',
      label: 'In/Out',
      icon: <ArrowRightLeft className="size-4" />,
    },
    {
      value: 'attributes',
      label: 'Attributes',
      icon: <Tags className="size-4" />,
    },
    {
      value: 'raw',
      label: 'RAW',
      icon: <SquareTerminal className="size-4" />,
    },
  ];

  function handleTabChange(tabValue: DetailsViewTab) {
    setTab(tabValue);
    onTabChange?.(tabValue);
  }

  const resolvedHeaderActions =
    typeof headerActions === 'function' ? headerActions(data) : headerActions;

  const headerContent = customHeader ? (
    typeof customHeader === 'function' ? (
      customHeader({ data })
    ) : (
      customHeader
    )
  ) : (
    <DetailsViewHeader
      data={data}
      avatar={avatar}
      copyButton={copyButton}
      actions={resolvedHeaderActions}
    />
  );

  return (
    <div className={cn('min-w-0 rounded-lg border border-border bg-card p-4 shadow-sm', className)}>
      {headerContent}

      <DetailsViewMetrics data={data} />

      <Tabs
        items={tabItems}
        value={tab}
        onValueChange={handleTabChange}
        theme="underline"
        defaultValue={defaultTab}
      />

      {tab === 'input-output' && <DetailsViewInputOutputTab data={data} />}
      {tab === 'attributes' && <DetailsViewAttributesTab data={data} />}
      {tab === 'raw' && <DetailsViewRawDataTab data={data} />}
    </div>
  );
};
