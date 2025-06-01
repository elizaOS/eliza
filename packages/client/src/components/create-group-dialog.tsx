import { useState, useEffect } from 'react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { getEntityId } from '@/lib/utils';
import type { UUID } from '@elizaos/core';
import { useNavigate } from 'react-router-dom';
import { useServers } from '@/hooks/use-query-hooks';

const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID; // Single default server
interface CreateGroupDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    serverId?: UUID; // Made optional - will use default if not provided
}

export function CreateGroupDialog({ open, onOpenChange, serverId: providedServerId }: CreateGroupDialogProps) {
    const [groupName, setGroupName] = useState('');
    const [isCreating, setIsCreating] = useState(false);
    const [effectiveServerId, setEffectiveServerId] = useState<UUID | null>(providedServerId || null);
    const { toast } = useToast();
    const navigate = useNavigate();
    const currentUserId = getEntityId();

    // Use default server if no serverId provided
    useEffect(() => {
        if (!providedServerId) {
            setEffectiveServerId(DEFAULT_SERVER_ID);
        }
    }, [providedServerId]);

    const handleCreate = async () => {
        if (!groupName.trim()) {
            toast({
                title: 'Error',
                description: 'Please enter a group name',
                variant: 'destructive',
            });
            return;
        }

        if (!effectiveServerId) {
            toast({
                title: 'Error',
                description: 'No server available. Please try again later.',
                variant: 'destructive',
            });
            return;
        }

        setIsCreating(true);
        try {
            const response = await apiClient.createCentralGroupChannel({
                name: groupName,
                participantCentralUserIds: [currentUserId as UUID], // Start with just current user
                server_id: effectiveServerId,
                type: 'group',
            });

            if (response.data) {
                toast({
                    title: 'Success',
                    description: `Group "${groupName}" created successfully`,
                });
                onOpenChange(false);
                setGroupName('');
                // Navigate to the new group
                navigate(`/group/${response.data.id}?serverId=${effectiveServerId}`);
            }
        } catch (error) {
            toast({
                title: 'Error',
                description: error instanceof Error ? error.message : 'Failed to create group',
                variant: 'destructive',
            });
        } finally {
            setIsCreating(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                    <DialogTitle>Create New Group</DialogTitle>
                    <DialogDescription>
                        Create a new group chat. You can add agents and other users after creating it.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                    <div className="grid grid-cols-4 items-center gap-4">
                        <Label htmlFor="name" className="text-right">
                            Name
                        </Label>
                        <Input
                            id="name"
                            value={groupName}
                            onChange={(e) => setGroupName(e.target.value)}
                            placeholder="My awesome group"
                            className="col-span-3"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !isCreating) {
                                    handleCreate();
                                }
                            }}
                        />
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isCreating}>
                        Cancel
                    </Button>
                    <Button onClick={handleCreate} disabled={isCreating || !groupName.trim()}>
                        {isCreating ? 'Creating...' : 'Create Group'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
} 