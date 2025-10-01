import type { TraceSpan } from '@evilmartians/agent-prism-types';

import { formatDuration, getTimelineData } from '@evilmartians/agent-prism-data';
import * as Collapsible from '@radix-ui/react-collapsible';
import { cn } from '@/lib/utils';
import { type FC, useCallback, type KeyboardEvent, type MouseEvent } from 'react';

import { Avatar, type AvatarProps } from '../Avatar.tsx';
import { getSpanCategoryTheme } from '../shared.ts';
import { SpanStatus } from '../SpanStatus.tsx';
import { SpanCardBadges } from './SpanCardBadges.tsx';
import { type SpanCardConnectorType, SpanCardConnector } from './SpanCardConnector.tsx';
import { SpanCardTimeline } from './SpanCardTimeline.tsx';
import { SpanCardToggle } from './SpanCardToggle.tsx';

const LAYOUT_CONSTANTS = {
  CONNECTOR_WIDTH: 20,
  CONTENT_BASE_WIDTH: 320,
} as const;

type ExpandButtonPlacement = 'inside' | 'outside';

export type SpanCardViewOptions = {
  withStatus?: boolean;
  expandButton?: ExpandButtonPlacement;
};

const DEFAULT_VIEW_OPTIONS: Required<SpanCardViewOptions> = {
  withStatus: true,
  expandButton: 'inside',
};

interface SpanCardProps {
  data: TraceSpan;
  level?: number;
  selectedSpan?: TraceSpan;
  avatar?: AvatarProps;
  onSpanSelect?: (span: TraceSpan) => void;
  minStart: number;
  maxEnd: number;
  isLastChild: boolean;
  prevLevelConnectors?: SpanCardConnectorType[];
  expandedSpansIds: string[];
  onExpandSpansIdsChange: (ids: string[]) => void;
  viewOptions?: SpanCardViewOptions;
}

interface SpanCardState {
  isExpanded: boolean;
  hasChildren: boolean;
  isSelected: boolean;
}

const getContentWidth = ({
  level,
  hasExpandButton,
  contentPadding,
  expandButton,
}: {
  level: number;
  hasExpandButton: boolean;
  contentPadding: number;
  expandButton: ExpandButtonPlacement;
}) => {
  let width = LAYOUT_CONSTANTS.CONTENT_BASE_WIDTH - level * LAYOUT_CONSTANTS.CONNECTOR_WIDTH;

  if (hasExpandButton && expandButton === 'inside') {
    width -= LAYOUT_CONSTANTS.CONNECTOR_WIDTH;
  }

  if (expandButton === 'outside' && level === 0) {
    width -= LAYOUT_CONSTANTS.CONNECTOR_WIDTH;
  }

  return width - contentPadding;
};

const getGridTemplateColumns = ({
  connectorsColumnWidth,
  expandButton,
}: {
  connectorsColumnWidth: number;
  expandButton: ExpandButtonPlacement;
}) => {
  if (expandButton === 'inside') {
    return `${connectorsColumnWidth}px 1fr`;
  }

  return `${connectorsColumnWidth}px 1fr ${LAYOUT_CONSTANTS.CONNECTOR_WIDTH}px`;
};

const getContentPadding = ({
  level,
  hasExpandButton,
}: {
  level: number;
  hasExpandButton: boolean;
}) => {
  if (level === 0) return 0;

  if (hasExpandButton) return 4;

  return 8;
};

const getConnectorsLayout = ({
  level,
  hasExpandButton,
  isLastChild,
  prevConnectors,
  expandButton,
}: {
  hasExpandButton: boolean;
  isLastChild: boolean;
  level: number;
  prevConnectors: SpanCardConnectorType[];
  expandButton: ExpandButtonPlacement;
}): {
  connectors: SpanCardConnectorType[];
  connectorsColumnWidth: number;
} => {
  const connectors: SpanCardConnectorType[] = [];

  if (level === 0) {
    return {
      connectors: expandButton === 'inside' ? [] : ['vertical'],
      connectorsColumnWidth: 20,
    };
  }

  for (let i = 0; i < level - 1; i++) {
    connectors.push('vertical');
  }

  if (!isLastChild) {
    connectors.push('t-right');
  }

  if (isLastChild) {
    connectors.push('corner-top-right');
  }

  let connectorsColumnWidth = connectors.length * LAYOUT_CONSTANTS.CONNECTOR_WIDTH;

  if (hasExpandButton) {
    connectorsColumnWidth += LAYOUT_CONSTANTS.CONNECTOR_WIDTH;
  }

  for (let i = 0; i < prevConnectors.length; i++) {
    if (prevConnectors[i] === 'empty' || prevConnectors[i] === 'corner-top-right') {
      connectors[i] = 'empty';
    }
  }

  return {
    connectors,
    connectorsColumnWidth,
  };
};

const useSpanCardEventHandlers = (data: TraceSpan, onSpanSelect?: (span: TraceSpan) => void) => {
  const handleCardClick = useCallback((): void => {
    onSpanSelect?.(data);
  }, [data, onSpanSelect]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleCardClick();
      }
    },
    [handleCardClick]
  );

  const handleToggleClick = useCallback((e: MouseEvent | KeyboardEvent): void => {
    e.stopPropagation();
  }, []);

  return {
    handleCardClick,
    handleKeyDown,
    handleToggleClick,
  };
};

const SpanCardChildren: FC<{
  data: TraceSpan;
  level: number;
  selectedSpan?: TraceSpan;
  onSpanSelect?: (span: TraceSpan) => void;
  minStart: number;
  maxEnd: number;
  prevLevelConnectors: SpanCardConnectorType[];
  expandedSpansIds: string[];
  onExpandSpansIdsChange: (ids: string[]) => void;
  viewOptions?: SpanCardViewOptions;
}> = ({
  data,
  level,
  selectedSpan,
  onSpanSelect,
  minStart,
  maxEnd,
  prevLevelConnectors,
  expandedSpansIds,
  onExpandSpansIdsChange,
  viewOptions = DEFAULT_VIEW_OPTIONS,
}) => {
  if (!data.children?.length) return null;

  return (
    <div className="relative">
      <Collapsible.Content>
        <ul role="group">
          {data.children.map((child, idx) => (
            <SpanCard
              viewOptions={viewOptions}
              key={child.id}
              data={child}
              minStart={minStart}
              maxEnd={maxEnd}
              level={level + 1}
              selectedSpan={selectedSpan}
              onSpanSelect={onSpanSelect}
              isLastChild={idx === (data.children || []).length - 1}
              prevLevelConnectors={prevLevelConnectors}
              expandedSpansIds={expandedSpansIds}
              onExpandSpansIdsChange={onExpandSpansIdsChange}
            />
          ))}
        </ul>
      </Collapsible.Content>
    </div>
  );
};

export const SpanCard: FC<SpanCardProps> = ({
  data,
  level = 0,
  selectedSpan,
  onSpanSelect,
  viewOptions = DEFAULT_VIEW_OPTIONS,
  avatar,
  minStart,
  maxEnd,
  isLastChild,
  prevLevelConnectors = [],
  expandedSpansIds,
  onExpandSpansIdsChange,
}) => {
  const isExpanded = expandedSpansIds.includes(data.id);

  const withStatus = viewOptions.withStatus ?? DEFAULT_VIEW_OPTIONS.withStatus;
  const expandButton = viewOptions.expandButton || DEFAULT_VIEW_OPTIONS.expandButton;

  const handleToggleClick = useCallback(
    (expanded: boolean) => {
      const alreadyExpanded = expandedSpansIds.includes(data.id);

      if (alreadyExpanded && !expanded) {
        onExpandSpansIdsChange(expandedSpansIds.filter((id) => id !== data.id));
      }

      if (!alreadyExpanded && expanded) {
        onExpandSpansIdsChange([...expandedSpansIds, data.id]);
      }
    },
    [isExpanded, expandedSpansIds, data.id, onExpandSpansIdsChange]
  );

  const state: SpanCardState = {
    isExpanded,
    hasChildren: Boolean(data.children?.length),
    isSelected: selectedSpan?.id === data.id,
  };

  const eventHandlers = useSpanCardEventHandlers(data, onSpanSelect);

  const { durationMs } = getTimelineData({
    spanCard: data,
    minStart,
    maxEnd,
  });

  const hasExpandButtonAsFirstChild = expandButton === 'inside' && state.hasChildren;

  const contentPadding = getContentPadding({
    level,
    hasExpandButton: hasExpandButtonAsFirstChild,
  });

  const contentWidth = getContentWidth({
    level,
    hasExpandButton: hasExpandButtonAsFirstChild,
    contentPadding,
    expandButton,
  });

  const { connectors, connectorsColumnWidth } = getConnectorsLayout({
    level,
    hasExpandButton: hasExpandButtonAsFirstChild,
    isLastChild,
    prevConnectors: prevLevelConnectors,
    expandButton,
  });

  const gridTemplateColumns = getGridTemplateColumns({
    connectorsColumnWidth,
    expandButton,
  });

  return (
    <li
      role="treeitem"
      aria-expanded={state.hasChildren ? state.isExpanded : undefined}
      className="list-none"
    >
      <Collapsible.Root open={state.isExpanded} onOpenChange={handleToggleClick}>
        <div
          className={cn(
            'relative grid w-full rounded-md transition-colors',
            state.isSelected ? 'bg-accent/50 border border-accent' : 'hover:bg-muted/30'
          )}
          style={{
            gridTemplateColumns,
          }}
          onClick={eventHandlers.handleCardClick}
          onKeyDown={eventHandlers.handleKeyDown}
          tabIndex={0}
          role="button"
          aria-pressed={state.isSelected}
          aria-describedby={`span-card-desc-${data.id}`}
          aria-expanded={state.hasChildren ? state.isExpanded : undefined}
          aria-label={`${state.isSelected ? 'Selected' : 'Not selected'} span card for ${data.title} at level ${level}`}
        >
          <div className="flex flex-nowrap">
            {connectors.map((connector, idx) => (
              <SpanCardConnector key={`${connector}-${idx}`} type={connector} />
            ))}

            {hasExpandButtonAsFirstChild && (
              <div className="flex w-5 flex-col items-center">
                <SpanCardToggle
                  isExpanded={state.isExpanded}
                  title={data.title}
                  onToggleClick={eventHandlers.handleToggleClick}
                />

                {state.isExpanded && <SpanCardConnector type="vertical" />}
              </div>
            )}
          </div>
          <div
            className={cn(
              'flex flex-nowrap items-center align-middle gap-x-3 gap py-3 px-2',
              'min-h-5 w-full cursor-pointer',
              level !== 0 && !hasExpandButtonAsFirstChild && 'pl-2',
              level !== 0 && hasExpandButtonAsFirstChild && 'pl-1'
            )}
          >
            <div
              className="relative flex min-h-4 flex-shrink-0 flex-grow-0 flex-wrap items-start gap-1"
              style={{
                width: `min(${contentWidth}px, 100%)`,
                minWidth: 140,
              }}
            >
              {avatar && <Avatar size="4" {...avatar} />}

              <h3
                className="mr-1 h-4 max-w-32 truncate text-sm leading-[14px] text-foreground "
                title={data.title}
              >
                {data.title}
              </h3>

              <SpanCardBadges data={data} />
            </div>

            <div className="flex flex-shrink flex-grow flex-nowrap items-center justify-end gap-1 min-w-0">
              {expandButton === 'outside' && withStatus && (
                <div className="flex-shrink-0">
                  <SpanStatus status={data.status} />
                </div>
              )}

              <SpanCardTimeline
                theme={getSpanCategoryTheme(data.type)}
                minStart={minStart}
                maxEnd={maxEnd}
                spanCard={data}
                className="max-w-48 flex-shrink"
              />

              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="inline-block w-14 whitespace-nowrap px-1 text-right text-xs text-foreground">
                  {formatDuration(durationMs)}
                </span>

                {expandButton === 'inside' && withStatus && (
                  <div>
                    <SpanStatus status={data.status} />
                  </div>
                )}
              </div>
            </div>
          </div>

          {expandButton === 'outside' &&
            (state.hasChildren ? (
              <SpanCardToggle
                isExpanded={state.isExpanded}
                title={data.title}
                onToggleClick={eventHandlers.handleToggleClick}
              />
            ) : (
              <div />
            ))}
        </div>

        <SpanCardChildren
          minStart={minStart}
          maxEnd={maxEnd}
          viewOptions={viewOptions}
          data={data}
          level={level}
          selectedSpan={selectedSpan}
          onSpanSelect={onSpanSelect}
          prevLevelConnectors={connectors}
          expandedSpansIds={expandedSpansIds}
          onExpandSpansIdsChange={onExpandSpansIdsChange}
        />
      </Collapsible.Root>
    </li>
  );
};
