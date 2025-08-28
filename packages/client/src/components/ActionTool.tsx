/**
 * ActionTool component - wraps prompt-kit Tool component for ElizaOS actions
 */

import React from 'react';
import { Tool, type ToolPart } from '@/components/ui/tool';
import { mapElizaActionToToolPart, type ElizaActionData } from '@/utils/action-mapper';
import { cn } from '@/lib/utils';

interface ActionToolProps {
  actionData: ElizaActionData;
  defaultOpen?: boolean;
  className?: string;
}

export function ActionTool({ 
  actionData, 
  defaultOpen = false, 
  className 
}: ActionToolProps) {
  // Convert ElizaOS action data to Tool component format
  const toolPart = mapElizaActionToToolPart(actionData);
  
  // Auto-expand on error or if explicitly requested
  const shouldExpand = defaultOpen || actionData.actionStatus === 'failed';
  
  return (
    <div className={cn("mt-2", className)}>
      <Tool 
        toolPart={toolPart} 
        defaultOpen={shouldExpand}
      />
    </div>
  );
}

interface ActionToolListProps {
  actions: ElizaActionData[];
  className?: string;
}

/**
 * ActionToolList - renders multiple action tools
 */
export function ActionToolList({ actions, className }: ActionToolListProps) {
  if (!actions || actions.length === 0) {
    return null;
  }

  return (
    <div className={cn("space-y-2", className)}>
      {actions.map((actionData, index) => (
        <ActionTool
          key={`${actionData.actionId || actionData.actionName}-${index}`}
          actionData={actionData}
        />
      ))}
    </div>
  );
}

export default ActionTool;
