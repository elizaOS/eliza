import PageTitle from '@/components/page-title';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAgentsWithDetails, useCentralServers } from '@/hooks/use-query-hooks';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '@/lib/api';
import { getEntityId } from '@/lib/utils'; // To include current user in group
import type { UUID } from '@elizaos/core';
import { ChannelType } from '@elizaos/core'; // For default group type
import { zodResolver } from '@hookform/resolvers/zod';
import React, { useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import * as z from 'zod';

const createGroupSchema = z.object({
  groupName: z.string().min(1, 'Group name is required').max(100, 'Group name too long'),
  serverId: z.string().uuid('Please select a server'),
  participantIds: z.array(z.string().uuid()).min(1, 'Select at least one participant'),
});

type CreateGroupFormData = z.infer<typeof createGroupSchema>;

const CreateGroupPage: React.FC = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const currentUserId = getEntityId();

  const { data: agentsData, isLoading: isLoadingAgents } = useAgentsWithDetails();
  const allAgents = useMemo(() => agentsData?.agents || [], [agentsData]);

  const { data: serversData, isLoading: isLoadingServers } = useCentralServers();
  const availableServers = useMemo(() => serversData?.data?.servers || [], [serversData]);

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
    watch,
    setValue,
  } = useForm<CreateGroupFormData>({
    resolver: zodResolver(createGroupSchema),
    defaultValues: {
      groupName: '',
      serverId: '',
      participantIds: currentUserId ? [currentUserId] : [], // Add current user by default
    },
  });

  const selectedParticipants = watch('participantIds');

  const onSubmit = async (data: CreateGroupFormData) => {
    try {
      const payload = {
        name: data.groupName,
        participantCentralUserIds: data.participantIds as UUID[],
        type: ChannelType.GROUP,
        server_id: data.serverId as UUID,
        metadata: { createdBy: currentUserId },
      };
      const response = await apiClient.createCentralGroupChannel(payload);
      if (response.data) {
        toast({
          title: 'Group Created',
          description: `Group "${response.data.name}" created successfully.`,
        });
        navigate(`/group/${response.data.id}?serverId=${response.data.messageServerId}`);
      } else {
        throw new Error('Failed to create group: No data returned from API.');
      }
    } catch (error) {
      toast({
        title: 'Error Creating Group',
        description: error instanceof Error ? error.message : 'Could not create group.',
        variant: 'destructive',
      });
    }
  };

  if (isLoadingAgents || isLoadingServers) {
    return <div className="p-4">Loading agent and server data...</div>;
  }

  return (
    <div className="container mx-auto p-4 md:p-6 lg:p-8 max-w-2xl">
      <PageTitle title="Create New Group Chat" />
      <form onSubmit={handleSubmit(onSubmit)}>
        <Card>
          <CardHeader>
            <CardTitle>Group Details</CardTitle>
            <CardDescription>Set up a new group chat with agents and other users.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="groupName">Group Name</Label>
              <Controller
                name="groupName"
                control={control}
                render={({ field }) => (
                  <Input id="groupName" placeholder="E.g., Project Phoenix Team" {...field} />
                )}
              />
              {errors.groupName && (
                <p className="text-sm text-red-500">{errors.groupName.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="serverId">Server / Context</Label>
              <Controller
                name="serverId"
                control={control}
                render={({ field }) => (
                  <select {...field} className="w-full p-2 border rounded-md bg-background">
                    <option value="" disabled>
                      Select a server
                    </option>
                    {availableServers.map((server) => (
                      <option key={server.id} value={server.id}>
                        {server.name}
                      </option>
                    ))}
                  </select>
                )}
              />
              {errors.serverId && <p className="text-sm text-red-500">{errors.serverId.message}</p>}
            </div>

            <div className="space-y-2">
              <Label>Participants</Label>
              <p className="text-xs text-muted-foreground">
                Select agents/users to include in this group. You are included by default.
              </p>
              <ScrollArea className="h-48 rounded-md border p-2">
                {allAgents.map((agent) => (
                  <div key={agent.id} className="flex items-center space-x-2 py-1">
                    <Checkbox
                      id={`participant-${agent.id}`}
                      checked={selectedParticipants.includes(agent.id!)}
                      onCheckedChange={(checked: boolean | 'indeterminate') => {
                        const currentValues = selectedParticipants || [];
                        if (checked === true) {
                          setValue('participantIds', [...currentValues, agent.id!]);
                        } else {
                          setValue(
                            'participantIds',
                            currentValues.filter((id) => id !== agent.id!)
                          );
                        }
                      }}
                      disabled={agent.id === currentUserId}
                    />
                    <label
                      htmlFor={`participant-${agent.id}`}
                      className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                    >
                      {agent.name} (Agent)
                    </label>
                  </div>
                ))}
                {/* TODO: Add other (non-agent) users if you have a central user system */}
                {allAgents.length === 0 && (
                  <p className="text-xs text-muted-foreground p-2">
                    No other agents available to add.
                  </p>
                )}
              </ScrollArea>
              {errors.participantIds && (
                <p className="text-sm text-red-500">{errors.participantIds.message}</p>
              )}
            </div>
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={isSubmitting} className="w-full">
              {isSubmitting ? 'Creating Group...' : 'Create Group'}
            </Button>
          </CardFooter>
        </Card>
      </form>
    </div>
  );
};

export default CreateGroupPage;
