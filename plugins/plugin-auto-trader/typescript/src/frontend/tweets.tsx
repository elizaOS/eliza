import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ExternalLink, Search } from 'lucide-react';
import moment from 'moment';
import Loader from './loader.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { Input } from './ui/input.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js';
import React from 'react';

export default function Tweets() {
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<'timestamp' | 'likes' | 'retweets'>('timestamp');

  const query = useQuery({
    queryKey: ['tweets'],
    queryFn: async () => {
      const response = await fetch('/api/intel/tweets', {
        method: 'GET',
      });
      const result = await response.json();
      return result.success ? result.data : [];
    },
    refetchInterval: 5_000,
  });

  if (query?.isPending) {
    return <Loader />;
  }

  const tweets = query?.data || [];

  // Filter and sort tweets
  const filteredTweets = tweets
    .filter(
      (tweet) =>
        !searchTerm ||
        tweet.text?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        tweet.username?.toLowerCase().includes(searchTerm.toLowerCase())
    )
    .sort((a, b) => {
      switch (sortBy) {
        case 'likes':
          return (b.likes || b.metadata?.likes || 0) - (a.likes || a.metadata?.likes || 0);
        case 'retweets':
          return (
            (b.retweets || b.metadata?.retweets || 0) - (a.retweets || a.metadata?.retweets || 0)
          );
        case 'timestamp':
        default:
          return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      }
    });

  // Calculate stats
  const totalTweets = tweets.length;
  const totalLikes = tweets.reduce(
    (sum, tweet) => sum + (tweet.likes || tweet.metadata?.likes || 0),
    0
  );
  const totalRetweets = tweets.reduce(
    (sum, tweet) => sum + (tweet.retweets || tweet.metadata?.retweets || 0),
    0
  );
  const avgEngagement = totalTweets > 0 ? (totalLikes + totalRetweets) / totalTweets : 0;

  const getEngagementColor = (likes: number, retweets: number) => {
    const total = likes + retweets;
    if (total >= 100) return 'text-green-600';
    if (total >= 50) return 'text-yellow-600';
    if (total >= 10) return 'text-blue-600';
    return 'text-muted-foreground';
  };

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Tweets</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalTweets}</div>
            <p className="text-xs text-muted-foreground">Collected tweets</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Likes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{totalLikes.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">Across all tweets</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Retweets</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{totalRetweets.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">Across all tweets</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Avg Engagement</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{avgEngagement.toFixed(1)}</div>
            <p className="text-xs text-muted-foreground">Likes + retweets</p>
          </CardContent>
        </Card>
      </div>

      {/* Tweets Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span>Recent Tweets</span>
              <Badge variant="secondary">{filteredTweets.length}</Badge>
            </div>
            <div className="flex items-center gap-2">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search tweets..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-8 w-64"
                />
              </div>

              {/* Sort Options */}
              <div className="flex gap-1">
                {[
                  { key: 'timestamp', label: 'Recent' },
                  { key: 'likes', label: 'Likes' },
                  { key: 'retweets', label: 'Retweets' },
                ].map((option) => (
                  <Button
                    key={option.key}
                    variant={sortBy === option.key ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSortBy(option.key as any)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">Time</TableHead>
                <TableHead className="w-[120px]">User</TableHead>
                <TableHead>Tweet</TableHead>
                <TableHead className="text-center w-[80px]">Likes</TableHead>
                <TableHead className="text-center w-[80px]">RTs</TableHead>
                <TableHead className="text-center w-[60px]">Link</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredTweets.map((item, index) => {
                const likes = item.likes || item.metadata?.likes || 0;
                const retweets = item.retweets || item.metadata?.retweets || 0;
                const username = item.username || item.metadata?.username || 'Unknown';
                const tweetId = item.id || item.metadata?.id;

                return (
                  <TableRow key={`${item._id || item.id || index}_${likes}`}>
                    <TableCell className="text-sm text-muted-foreground">
                      {moment(item.timestamp).format('MMM DD, HH:mm')}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-blue-100 grid place-items-center text-xs font-medium">
                          {username[0]?.toUpperCase()}
                        </div>
                        <span className="font-medium text-sm truncate max-w-[80px]">
                          @{username}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="max-w-md">
                        <p className="text-sm leading-relaxed line-clamp-3">{item.text}</p>
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge
                        variant="outline"
                        className={`${getEngagementColor(likes, retweets)} border-0 bg-red-50`}
                      >
                        ❤️ {likes}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge
                        variant="outline"
                        className={`${getEngagementColor(likes, retweets)} border-0 bg-blue-50`}
                      >
                        🔄 {retweets}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      {tweetId && username && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            window.open(`https://x.com/${username}/status/${tweetId}`, '_blank');
                          }}
                        >
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {filteredTweets.length === 0 && (
            <div className="text-center py-8">
              <p className="text-muted-foreground">
                {searchTerm ? 'No tweets match your search' : 'No tweets available'}
              </p>
              <p className="text-sm text-muted-foreground mt-2">
                {searchTerm
                  ? 'Try adjusting your search terms'
                  : 'Tweets will appear here once the Twitter plugin is active'}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
