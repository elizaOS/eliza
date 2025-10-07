import React from 'react';
import { Link } from 'react-router-dom';

const CharacterList: React.FC = () => {
  // This is a placeholder component - in a real implementation,
  // you would fetch character data from an API
  const characters = [
    { id: '1', name: 'Character 1' },
    { id: '2', name: 'Character 2' },
    { id: '3', name: 'Character 3' },
  ];

  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold mb-4">Characters</h1>
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {characters.map((character) => (
          <div key={character.id} className="border rounded-lg p-4 shadow-sm">
            <h2 className="text-xl font-semibold">{character.name}</h2>
            <Link to={`/characters/${character.id}`} className="text-blue-500 hover:underline">
              View Details
            </Link>
          </div>
        ))}
      </div>
      <div className="mt-4">
        <Link
          to="/characters/new"
          className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
        >
          Create New Character
        </Link>
      </div>
    </div>
  );
};

export default CharacterList;
