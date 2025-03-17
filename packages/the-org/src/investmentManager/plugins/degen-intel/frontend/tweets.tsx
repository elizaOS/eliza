import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import moment from 'moment';
import Loader from './loader';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

export default function Tweets() {
  const query = useQuery({
    queryKey: ['tweets'],
    queryFn: async () => {
      const response = await fetch(`${import.meta.env.VITE_API_URL}/tweets`, {
        method: 'POST',
      });
      const data = await response.json();
      return data;
    },
    refetchInterval: 5_000,
  });

  if (query?.isPending) {
    return <Loader />;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Timestamp</TableHead>
          <TableHead>ID</TableHead>
          <TableHead>Username</TableHead>
          <TableHead className="w-[750px]">Tweet</TableHead>
          <TableHead className="text-center">Likes</TableHead>
          <TableHead className="text-center">Retweets</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {query?.data?.map((item) => (
          <TableRow key={`${item._id}_${item.likes}`}>
            <TableCell>{moment(item.timestamp).format('LLL')}</TableCell>
            <TableCell>
              <div className="flex items-center gap-2">
                <div>{item.id}</div>
                <a
                  href={`https://x.com/${item.username}/status/${item.id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink className="size-4 text-muted-foreground" />
                </a>
              </div>
            </TableCell>
            <TableCell>{item.username}</TableCell>
            <TableCell>
              <div className="line-clamp-1">{item.text}</div>
            </TableCell>
            <TableCell className="text-center">{item.likes}</TableCell>
            <TableCell className="text-center">{item.retweets}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
