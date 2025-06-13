import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronUp, LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

// Types
export interface CardBadge {
    text: string;
    variant?: 'default' | 'secondary' | 'outline';
    className?: string;
}

export interface CardMetadata {
    icon?: LucideIcon;
    text: string;
    className?: string;
}

export interface CardAction {
    icon: LucideIcon;
    onClick: () => void;
    tooltip?: string;
    className?: string;
    variant?: 'ghost' | 'outline' | 'default';
}

export interface HierarchicalCardProps {
    // Visual indicator
    indicatorColor: string;
    indicatorHeight?: string;

    // Header content
    icon: LucideIcon;
    title: string;
    subtitle?: string;
    badges?: CardBadge[];
    metadata?: CardMetadata[];

    // Actions
    actions?: CardAction[];

    // Content
    children?: React.ReactNode;

    // Expandable behavior
    expandable?: boolean;
    defaultExpanded?: boolean;
    onExpand?: (expanded: boolean) => void;

    // Styling
    className?: string;
    headerClassName?: string;
    contentClassName?: string;

    // Preview content for collapsed state
    previewContent?: React.ReactNode;
}

export interface CardSectionProps {
    title?: string;
    children: React.ReactNode;
    className?: string;
    collapsible?: boolean;
    defaultCollapsed?: boolean;
}

// Card Section Component
export function CardSection({
    title,
    children,
    className,
    collapsible = false,
    defaultCollapsed = false
}: CardSectionProps) {
    const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

    return (
        <div className={cn('space-y-2', className)}>
            {title && (
                <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">{title}</span>
                    {collapsible && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setIsCollapsed(!isCollapsed)}
                            className="h-6 px-2 text-xs"
                        >
                            {isCollapsed ? 'Show' : 'Hide'}
                        </Button>
                    )}
                </div>
            )}
            {!isCollapsed && (
                <div className="bg-surface-overlay border border-border-subtle rounded-none p-3">
                    {children}
                </div>
            )}
        </div>
    );
}

// Main Hierarchical Card Component
export function HierarchicalCard({
    indicatorColor,
    indicatorHeight = 'h-16',
    icon: IconComponent,
    title,
    subtitle,
    badges = [],
    metadata = [],
    actions = [],
    children,
    expandable = false,
    defaultExpanded = false,
    onExpand,
    className,
    headerClassName,
    contentClassName,
    previewContent,
}: HierarchicalCardProps) {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded);

    const handleExpand = () => {
        const newExpanded = !isExpanded;
        setIsExpanded(newExpanded);
        onExpand?.(newExpanded);
    };

    const hasContent = children || previewContent;
    const showExpandButton = expandable && hasContent;

    return (
        <div className={cn(
            'border border-border-subtle rounded-none bg-surface-raised hover:bg-interactive-hover/20 transition-colors group',
            className
        )}>
            {/* Header */}
            <div className={cn('flex items-start gap-4 p-4', headerClassName)}>
                {/* Visual indicator bar */}
                <div className={cn('w-1 rounded-full flex-shrink-0', indicatorHeight, indicatorColor)} />

                <div className="flex items-start justify-between w-full">
                    <div className="flex items-start gap-3 flex-1">
                        {/* Icon */}
                        <div className="p-2 rounded-none bg-surface-overlay border border-border-subtle">
                            <IconComponent className="h-4 w-4 text-text-muted" />
                        </div>

                        {/* Title and metadata */}
                        <div className="flex-1 min-w-0">
                            {/* Title and badges */}
                            <div className="flex items-center gap-2 mb-2">
                                <h4 className="font-semibold text-sm text-text-primary truncate">{title}</h4>
                                {badges.map((badge, index) => (
                                    <span
                                        key={index}
                                        className={cn(
                                            'text-xs px-2 py-0.5 rounded-none border bg-surface-overlay border-border-subtle text-text-muted',
                                            badge.className
                                        )}
                                    >
                                        {badge.text}
                                    </span>
                                ))}
                            </div>

                            {/* Subtitle */}
                            {subtitle && (
                                <p className="text-sm text-text-secondary mb-2">{subtitle}</p>
                            )}

                            {/* Metadata */}
                            {metadata.length > 0 && (
                                <div className="space-y-1">
                                    {metadata.map((item, index) => (
                                        <div key={index} className={cn('flex items-center gap-2 text-xs text-text-muted', item.className)}>
                                            {item.icon && <item.icon className="h-3 w-3" />}
                                            <span className="font-mono">{item.text}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Action buttons */}
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {showExpandButton && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={handleExpand}
                                className="h-8 w-8 p-0 hover:bg-interactive-hover"
                                title={isExpanded ? 'Collapse details' : 'Expand details'}
                            >
                                {isExpanded ? (
                                    <ChevronUp className="h-3 w-3" />
                                ) : (
                                    <ChevronDown className="h-3 w-3" />
                                )}
                            </Button>
                        )}
                        {actions.map((action, index) => (
                            <Button
                                key={index}
                                variant={action.variant || 'ghost'}
                                size="sm"
                                onClick={action.onClick}
                                className={cn('h-8 w-8 p-0 hover:bg-interactive-hover', action.className)}
                                title={action.tooltip}
                            >
                                <action.icon className="h-3 w-3" />
                            </Button>
                        ))}
                    </div>
                </div>
            </div>

            {/* Content */}
            {hasContent && (
                <>
                    {/* Expanded content */}
                    {isExpanded && children && (
                        <>
                            <div className="border-t border-border-subtle" />
                            <div className={cn('p-4 pt-3 space-y-4', contentClassName)}>
                                {children}
                            </div>
                        </>
                    )}

                    {/* Preview content for collapsed state */}
                    {!isExpanded && previewContent && (
                        <>
                            <div className="border-t border-border-subtle" />
                            <div className="p-4 pt-3 bg-surface-overlay/50">
                                {previewContent}
                            </div>
                        </>
                    )}
                </>
            )}
        </div>
    );
}

// Utility function for common color patterns
export const cardColors = {
    primary: 'bg-interactive-primary',
    success: 'bg-emerald-600/80',
    warning: 'bg-amber-600/80',
    error: 'bg-red-600/80',
    info: 'bg-blue-600/80',
    neutral: 'bg-slate-500',
    agent: 'bg-interactive-primary',
    user: 'bg-slate-500',
    thought: 'bg-emerald-600/80',
    llm: 'bg-emerald-600/80',
    image: 'bg-amber-600/80',
    transcription: 'bg-blue-600/80',
    embedding: 'bg-purple-600/80',
} as const; 