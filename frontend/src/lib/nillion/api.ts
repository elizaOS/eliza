import { nillionClient, Bounty } from './client';
import { SCHEMA_IDS, RECORD_IDS } from './constants';
import { NillionError } from './errors';
import { BountyListParams } from '@/types/nillion';

export async function getBountyList(params?: BountyListParams) {
  try {
    console.log('[NillionAPI] Fetching bounties with params:', params);

    // Get collection
    const collection = await nillionClient.getCollection(SCHEMA_IDS.BOUNTY);
    console.log('[NillionAPI] Collection initialized');

    // Retrieve data
    const bountiesData = await collection.readFromNodes({});
    console.log('[NillionAPI] Raw bounties data:', bountiesData);

    if (!bountiesData || !Array.isArray(bountiesData) || bountiesData.length === 0) {
      console.log('[NillionAPI] No bounties found');
      return { items: [], total: 0, hasMore: false };
    }

    const bounties = bountiesData[0]?.bounties || [];
    console.log('[NillionAPI] Found bounties:', bounties.length);

    // Transform bounties to match the expected format
    const transformedBounties: Bounty[] = bounties.map((bounty: any) => ({
      title: bounty.title || '',
      owner: bounty.owner || '',
      requiredSkills: bounty.requiredSkills || '',
      datePosted: bounty.datePosted || '',
      dueDate: bounty.dueDate || '',
      state: bounty.state || 'Open',
      estimatedTime: bounty.estimatedTime || '',
      description: bounty.description || '',
      longDescription: bounty.longDescription || '',
      bountyId: bounty.bountyId || '',
      reward: {
        amount: bounty.reward?.amount || '0',
        token: bounty.reward?.token || 'ETH',
        chainId: bounty.reward?.chainId || '1'
      }
    }));

    // Filter by owner if specified
    const filteredBounties = params?.owner 
      ? transformedBounties.filter(bounty => bounty.owner === params.owner)
      : transformedBounties;

    return {
      items: filteredBounties,
      total: filteredBounties.length,
      hasMore: false // TODO: Implement pagination
    };
  } catch (error) {
    console.error('[NillionAPI] Error fetching bounties:', error);
    throw NillionError.fromError(error, 'FETCH_BOUNTIES_ERROR');
  }
}

export async function createBounty(bountyData: any) {
  try {
    console.log('[NillionAPI] Creating bounty:', bountyData);

    // Get collection
    const collection = await nillionClient.getCollection(SCHEMA_IDS.BOUNTY);
    console.log('[NillionAPI] Collection initialized');

    // Retrieve current bounties
    const bountiesData = await collection.readFromNodes({});
    console.log('[NillionAPI] Current bounties data:', bountiesData);

    if (!bountiesData || !Array.isArray(bountiesData) || bountiesData.length === 0) {
      throw new NillionError('Failed to retrieve bounties collection', 'FETCH_BOUNTIES_ERROR');
    }

    const currentBounties = bountiesData[0]?.bounties || [];
    const newBounties = [...currentBounties, bountyData];

    // Update data
    await collection.updateDataToNodes(
      { bounties: newBounties },
      { _id: RECORD_IDS.BOUNTY }
    );

    console.log('[NillionAPI] Bounty created successfully');
    return bountyData;
  } catch (error) {
    console.error('[NillionAPI] Error creating bounty:', error);
    throw NillionError.fromError(error, 'CREATE_BOUNTY_ERROR');
  }
}
