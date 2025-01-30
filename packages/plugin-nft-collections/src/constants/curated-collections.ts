import { z } from "zod";

export const CollectionCategory = z.enum([
    "Gen Art",
    "Photography",
    "AI Inspired",
    "Memetics",
    "Iconic Gems",
]);

//export type CollectionCategory = z.infer<typeof CollectionCategory>;

export const CuratedCollectionSchema = z.object({
    address: z.string(),
    name: z.string(),
    category: CollectionCategory,
    creator: z.string().optional(),
    tokenIdRange: z
        .object({
            start: z.string().optional(),
            end: z.string().optional(),
        })
        .optional(),
});

export type CuratedCollection = z.infer<typeof CuratedCollectionSchema>;

/**
 * Curated list of NFT collections featured on ikigailabs.xyz
 */
export const CURATED_COLLECTIONS: CuratedCollection[] = [
    // Gen Art Collections
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Fidenza",
        category: "Gen Art",
        creator: "Tyler Hobbs",
        tokenIdRange: {
            start: "78000000",
            end: "78999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Ringers",
        category: "Gen Art",
        creator: "Dmitri Cherniak",
        tokenIdRange: {
            start: "13000000",
            end: "13999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Pigments",
        category: "Gen Art",
        creator: "Darien Brito",
        tokenIdRange: {
            start: "129000000",
            end: "129999999",
        },
    },
    {
        address: "0x99a9b7c1116f9ceeb1652de04d5969cce509b069",
        name: "Human Unreadable",
        category: "Gen Art",
        creator: "Operator",
        tokenIdRange: {
            start: "455000000",
            end: "455999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Skulptuur",
        category: "Gen Art",
        creator: "Piter Pasma",
        tokenIdRange: {
            start: "173000000",
            end: "173999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Scribbled Boundaries",
        category: "Gen Art",
        creator: "William Tan",
        tokenIdRange: {
            start: "131000000",
            end: "131999999",
        },
    },
    {
        address: "0x99a9b7c1116f9ceeb1652de04d5969cce509b069",
        name: "The Harvest",
        category: "Gen Art",
        creator: "Per Kristian Stoveland",
        tokenIdRange: {
            start: "407000000",
            end: "407999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Fragments of an Infinite Field",
        category: "Gen Art",
        creator: "Monica Rizzolli",
        tokenIdRange: {
            start: "159000000",
            end: "159999999",
        },
    },
    {
        address: "0x0a1bbd57033f57e7b6743621b79fcb9eb2ce3676",
        name: "FOLIO",
        category: "Gen Art",
        creator: "Matt DesLauriers",
        tokenIdRange: {
            start: "8000000",
            end: "8999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Meridian",
        category: "Gen Art",
        creator: "Matt DesLauriers",
        tokenIdRange: {
            start: "163000000",
            end: "163999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Archetype",
        category: "Gen Art",
        creator: "Kjetil Golid",
        tokenIdRange: {
            start: "23000000",
            end: "23999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Gazers",
        category: "Gen Art",
        creator: "Matt Kane",
        tokenIdRange: {
            start: "215000000",
            end: "215999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Subscapes",
        category: "Gen Art",
        creator: "Matt DesLauriers",
        tokenIdRange: {
            start: "53000000",
            end: "53999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Anticyclone",
        category: "Gen Art",
        creator: "William Mapan",
        tokenIdRange: {
            start: "304000000",
            end: "304999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Memories of Qilin",
        category: "Gen Art",
        creator: "Emily Xie",
        tokenIdRange: {
            start: "282000000",
            end: "282999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Elevated Deconstructions",
        category: "Gen Art",
        creator: "luxpris",
        tokenIdRange: {
            start: "7000000",
            end: "7999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Screens",
        category: "Gen Art",
        creator: "Thomas Lin Pedersen",
        tokenIdRange: {
            start: "255000000",
            end: "255999999",
        },
    },
    {
        address: "0x059edd72cd353df5106d2b9cc5ab83a52287ac3a",
        name: "Genesis",
        category: "Gen Art",
        creator: "DCA",
        tokenIdRange: {
            start: "1000000",
            end: "1999999",
        },
    },
    {
        address: "0x8cdbd7010bd197848e95c1fd7f6e870aac9b0d3c",
        name: "///",
        category: "Gen Art",
        creator: "Snowfro",
        tokenIdRange: {
            start: "2000000",
            end: "2999999",
        },
    },
    {
        address: "0x0a1bbd57033f57e7b6743621b79fcb9eb2ce3676",
        name: "100 Untitled Spaces",
        category: "Gen Art",
        creator: "Snowfro",
        tokenIdRange: {
            start: "28000000",
            end: "28999999",
        },
    },
    {
        address: "0x0a1bbd57033f57e7b6743621b79fcb9eb2ce3676",
        name: "Inflection",
        category: "Gen Art",
        creator: "Jeff Davis",
        tokenIdRange: {
            start: "3000000",
            end: "3999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Rapture",
        category: "Gen Art",
        creator: "Thomas Lin Pedersen",
        tokenIdRange: {
            start: "141000000",
            end: "141999999",
        },
    },
    {
        address: "0x99a9b7c1116f9ceeb1652de04d5969cce509b069",
        name: "Blind Spots",
        category: "Gen Art",
        creator: "Shaderism",
        tokenIdRange: {
            start: "484000000",
            end: "484999999",
        },
    },
    {
        address: "0xc73b17179bf0c59cd5860bb25247d1d1092c1088",
        name: "QQL Mint Pass",
        category: "Gen Art",
        creator: "Tyler Hobbs & Dandelion Wist",
    },
    {
        address: "0x495f947276749ce646f68ac8c248420045cb7b5e",
        name: "888",
        category: "Gen Art",
        creator: "Kevin Abosch",
        tokenIdRange: {
            start: "opensea-888-by-kevin-abosch",
            end: "opensea-888-by-kevin-abosch",
        },
    },
    {
        address: "0x0e42ffbac75bcc30cd0015f8aaa608539ba35fbb",
        name: "Mind the Gap",
        category: "Gen Art",
        creator: "MountVitruvius",
    },
    {
        address: "0x7d2d93eed47e55c873b9580b4e6ebd5bc045d1b6",
        name: "Mercedes",
        category: "Gen Art",
    },
    {
        address: "0x4e1f41613c9084fdb9e34e11fae9412427480e56",
        name: "Terraforms",
        category: "Gen Art",
        creator: "Mathcastles",
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Hōrō",
        category: "Gen Art",
        creator: "makio135",
    },
    {
        address: "0x2b0bfa93beb22f44e7c1be88efd80396f8d9f1d4",
        name: "STATE OF THE ART",
        category: "Gen Art",
        creator: "ThankYouX",
    },
    {
        address: "0xA4F6105B612f913e468F6B27FCbb48c3569ACbE7",
        name: "TECTONICS",
        category: "Gen Art",
        creator: "mpkoz",
    },
    {
        address: "0x845dd2a7ee2a92a0518ab2135365ed63fdba0c88",
        name: "QQL",
        category: "Gen Art",
        creator: "Tyler Hobbs & Dandelion Wist",
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Passin",
        category: "Gen Art",
        tokenIdRange: {
            start: "314000000",
            end: "314999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Yazid",
        category: "Gen Art",
        tokenIdRange: {
            start: "281000000",
            end: "281999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Radix 2",
        category: "Gen Art",
        tokenIdRange: {
            start: "139000000",
            end: "139999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Radix 1",
        category: "Gen Art",
        tokenIdRange: {
            start: "104000000",
            end: "104999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Catblocks",
        category: "Gen Art",
        tokenIdRange: {
            start: "73000000",
            end: "73999999",
        },
    },
    {
        address: "0x4d928ab507bf633dd8e68024a1fb4c99316bbdf3",
        name: "Love Tennis",
        category: "Gen Art",
    },
    {
        address: "0x99a9b7c1116f9ceeb1652de04d5969cce509b069",
        name: "Renders Game",
        category: "Gen Art",
        creator: "MountVitruvius",
        tokenIdRange: {
            start: "415000000",
            end: "415999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Running Moon",
        category: "Gen Art",
        creator: "Licia He",
        tokenIdRange: {
            start: "334000000",
            end: "334999999",
        },
    },
    {
        address: "0x99a9b7c1116f9ceeb1652de04d5969cce509b069",
        name: "Neural Sediments",
        category: "Gen Art",
        creator: "Eko33",
        tokenIdRange: {
            start: "418000000",
            end: "418999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Fontana",
        category: "Gen Art",
        creator: "Harvey Rayner",
        tokenIdRange: {
            start: "367000000",
            end: "367999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Algobots",
        category: "Gen Art",
        creator: "Stina Jones",
        tokenIdRange: {
            start: "40000000",
            end: "40999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Apparitions",
        category: "Gen Art",
        creator: "Aaron Penne",
        tokenIdRange: {
            start: "28000000",
            end: "28999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "[Dis]entanglement",
        category: "Gen Art",
        creator: "onlygenerated",
        tokenIdRange: {
            start: "97000000",
            end: "97999999",
        },
    },
    {
        address: "0x99a9b7c1116f9ceeb1652de04d5969cce509b069",
        name: "Semblance",
        category: "Gen Art",
        creator: "rahul iyer",
        tokenIdRange: {
            start: "447000000",
            end: "447999999",
        },
    },
    {
        address: "0xCe3aB0D9D5e36a12235def6CaB84C355D51703aB",
        name: "Interference",
        category: "Gen Art",
        creator: "Phaust",
    },
    {
        address: "0x495f947276749ce646f68ac8c248420045cb7b5e",
        name: "888",
        category: "Gen Art",
        creator: "Kevin Abosch",
        tokenIdRange: {
            start: "opensea-888-by-kevin-abosch",
            end: "opensea-888-by-kevin-abosch",
        },
    },
    {
        address: "0x2DB452c9A7b14f927F51589a54B4D56dD4B31977",
        name: "Web",
        category: "Gen Art",
        creator: "Jan Robert Leegte / Superposition",
    },
    {
        address: "0x7F72528229F85C99D8843C0317eF91F4A2793Edf",
        name: "1111",
        category: "Gen Art",
        creator: "Kevin Abosch",
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Geometry Runners",
        category: "Gen Art",
        creator: "Rich Lord",
        tokenIdRange: {
            start: "138000000",
            end: "138999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Ecumenopolis",
        category: "Gen Art",
        creator: "Joshua Bagley",
        tokenIdRange: {
            start: "119000000",
            end: "119999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Edifice",
        category: "Gen Art",
        creator: "Ben Kovach",
        tokenIdRange: {
            start: "204000000",
            end: "204999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Singularity",
        category: "Gen Art",
        creator: "Hideki Tsukamoto",
        tokenIdRange: {
            start: "8000000",
            end: "8999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Rinascita",
        category: "Gen Art",
        creator: "Stefano Contiero",
        tokenIdRange: {
            start: "121000000",
            end: "121999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Alien Insects",
        category: "Gen Art",
        creator: "Shvembldr",
        tokenIdRange: {
            start: "137000000",
            end: "137999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "720 Minutes",
        category: "Gen Art",
        creator: "Alexis André",
        tokenIdRange: {
            start: "27000000",
            end: "27999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "CENTURY",
        category: "Gen Art",
        creator: "Casey REAS",
        tokenIdRange: {
            start: "100000000",
            end: "100999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "LeWitt Generator Generator",
        category: "Gen Art",
        creator: "Mitchell F. Chan",
        tokenIdRange: {
            start: "118000000",
            end: "118999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Endless Nameless",
        category: "Gen Art",
        creator: "Rafaël Rozendaal",
        tokenIdRange: {
            start: "120000000",
            end: "120999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Obicera",
        category: "Gen Art",
        creator: "Alexis André",
        tokenIdRange: {
            start: "130000000",
            end: "130999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Bubble Blobby",
        category: "Gen Art",
        creator: "Jason Ting",
        tokenIdRange: {
            start: "62000000",
            end: "62999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Divisions",
        category: "Gen Art",
        creator: "Michael Connolly",
        tokenIdRange: {
            start: "108000000",
            end: "108999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Phototaxis",
        category: "Gen Art",
        creator: "Casey REAS",
        tokenIdRange: {
            start: "164000000",
            end: "164999999",
        },
    },
    {
        address: "0x99a9b7c1116f9ceeb1652de04d5969cce509b069",
        name: "ORI",
        category: "Gen Art",
        creator: "James Merrill",
        tokenIdRange: {
            start: "379000000",
            end: "379999999",
        },
    },
    {
        address: "0x99a9b7c1116f9ceeb1652de04d5969cce509b069",
        name: "Trichro-matic",
        category: "Gen Art",
        creator: "MountVitruvius",
        tokenIdRange: {
            start: "482000000",
            end: "482999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Return",
        category: "Gen Art",
        creator: "Aaron Penne",
        tokenIdRange: {
            start: "77000000",
            end: "77999999",
        },
    },
    {
        address: "0x99a9b7c1116f9ceeb1652de04d5969cce509b069",
        name: "Pre-Process",
        category: "Gen Art",
        creator: "Casey REAS",
        tokenIdRange: {
            start: "383000000",
            end: "383999999",
        },
    },
    {
        address: "0x99a9b7c1116f9ceeb1652de04d5969cce509b069",
        name: "Cargo",
        category: "Gen Art",
        creator: "Kim Asendorf",
        tokenIdRange: {
            start: "426000000",
            end: "426999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Ieva",
        category: "Gen Art",
        creator: "Shvembldr",
        tokenIdRange: {
            start: "339000000",
            end: "339999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Color Study",
        category: "Gen Art",
        creator: "Jeff Davis",
        tokenIdRange: {
            start: "16000000",
            end: "16999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "R3sonance",
        category: "Gen Art",
        creator: "ge1doot",
        tokenIdRange: {
            start: "19000000",
            end: "19999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Primitives",
        category: "Gen Art",
        creator: "Aranda\\Lasch",
        tokenIdRange: {
            start: "368000000",
            end: "368999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "RASTER",
        category: "Gen Art",
        creator: "itsgalo",
        tokenIdRange: {
            start: "341000000",
            end: "341999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Messengers",
        category: "Gen Art",
        creator: "Alexis André",
        tokenIdRange: {
            start: "68000000",
            end: "68999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Squares",
        category: "Gen Art",
        creator: "Martin Grasser",
        tokenIdRange: {
            start: "330000000",
            end: "330999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "The Liths of Sisyphus",
        category: "Gen Art",
        creator: "nonfigurativ",
        tokenIdRange: {
            start: "124000000",
            end: "124999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Stroming",
        category: "Gen Art",
        creator: "Bart Simons",
        tokenIdRange: {
            start: "86000000",
            end: "86999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Paths",
        category: "Gen Art",
        creator: "Darien Brito",
        tokenIdRange: {
            start: "217000000",
            end: "217999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Enchiridion",
        category: "Gen Art",
        creator: "Generative Artworks",
        tokenIdRange: {
            start: "101000000",
            end: "101999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Getijde",
        category: "Gen Art",
        creator: "Bart Simons",
        tokenIdRange: {
            start: "226000000",
            end: "226999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Flux",
        category: "Gen Art",
        creator: "Owen Moore",
        tokenIdRange: {
            start: "296000000",
            end: "296999999",
        },
    },
    {
        address: "0x99a9b7c1116f9ceeb1652de04d5969cce509b069",
        name: "Good, Computer",
        category: "Gen Art",
        creator: "Dean Blacc",
        tokenIdRange: {
            start: "396000000",
            end: "396999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Non Either",
        category: "Gen Art",
        creator: "Rafaël Rozendaal",
        tokenIdRange: {
            start: "260000000",
            end: "260999999",
        },
    },
    {
        address: "0x99a9b7c1116f9ceeb1652de04d5969cce509b069",
        name: "Gumbo",
        category: "Gen Art",
        creator: "Mathias Isaksen",
        tokenIdRange: {
            start: "462000000",
            end: "462999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "70s Pop Series One",
        category: "Gen Art",
        creator: "Daniel Catt",
        tokenIdRange: {
            start: "46000000",
            end: "46999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Vahria",
        category: "Gen Art",
        creator: "Darien Brito",
        tokenIdRange: {
            start: "340000000",
            end: "340999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Pointila",
        category: "Gen Art",
        creator: "Phaust",
        tokenIdRange: {
            start: "353000000",
            end: "353999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Intersections",
        category: "Gen Art",
        creator: "Rafaël Rozendaal",
        tokenIdRange: {
            start: "373000000",
            end: "373999999",
        },
    },
    {
        address: "0x99a9b7c1116f9ceeb1652de04d5969cce509b069",
        name: "This Is Not A Rock",
        category: "Gen Art",
        creator: "Nicole Vella",
        tokenIdRange: {
            start: "471000000",
            end: "471999999",
        },
    },
    {
        address: "0x99a9b7c1116f9ceeb1652de04d5969cce509b069",
        name: "Immaterial",
        category: "Gen Art",
        creator: "Bjørn Staal",
        tokenIdRange: {
            start: "481000000",
            end: "481999999",
        },
    },
    {
        address: "0x7d2d93eed47e55c873b9580b4e6ebd5bc045d1b6",
        name: "Maschine",
        category: "Gen Art",
    },
    {
        address: "0xcbc8a5472bba032125c1a7d11427aa3b5035207b",
        name: "Blocks",
        category: "Gen Art",
        creator: "Harto",
    },
    {
        address: "0x145789247973c5d612bf121e9e4eef84b63eb707",
        name: "923 EMPTY ROOMS",
        category: "Gen Art",
        creator: "Casey REAS",
        tokenIdRange: {
            start: "1000000",
            end: "1999999",
        },
    },
    {
        address: "0x71b1956bc6640a70893e49f5816724425891f159",
        name: "Fleeting Thoughts",
        category: "Gen Art",
        creator: "Nadieh Bremer",
    },
    {
        address: "0xc332fa232ab53628d0e9acbb806c5ee5a82b3467",
        name: "Hypnagogic",
        category: "Gen Art",
        creator: "rudxane",
    },
    {
        address: "0x32d4be5ee74376e08038d652d4dc26e62c67f436",
        name: "Elefante",
        category: "Gen Art",
        creator: "Michael Connolly",
        tokenIdRange: {
            start: "4000000",
            end: "4999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Brushpops",
        category: "Gen Art",
        creator: "Matty Mariansky",
        tokenIdRange: {
            start: "135000000",
            end: "135999999",
        },
    },
    {
        address: "0xeb7088423d7f8c1448ef074fc372bc67efa4de44",
        name: "Toys",
        category: "Gen Art",
        creator: "0xTechno",
    },
    {
        address: "0x99a9b7c1116f9ceeb1652de04d5969cce509b069",
        name: "Fleur",
        category: "Gen Art",
        creator: "AnaPet",
        tokenIdRange: {
            start: "378000000",
            end: "378999999",
        },
    },
    {
        address: "0x29e891f4f2ae6a516026e3bcf0353d798e1de90",
        name: "Cathartic Prism",
        category: "Gen Art",
    },
    {
        address: "0x0a1bbd57033f57e7b6743621b79fcb9eb2ce3676",
        name: "100 Sunsets",
        category: "Gen Art",
        creator: "Zach Lieberman",
        tokenIdRange: {
            start: "29000000",
            end: "29999999",
        },
    },
    {
        address: "0x0a1bbd57033f57e7b6743621b79fcb9eb2ce3676",
        name: "Sparkling Goodbye",
        category: "Gen Art",
        creator: "Licia He",
        tokenIdRange: {
            start: "47000000",
            end: "47999999",
        },
    },
    {
        address: "0xe034bb2b1b9471e11cf1a0a9199a156fb227aa5d",
        name: "Themes and Variations",
        category: "Gen Art",
        creator: "Vera Molnár",
    },
    {
        address: "0x0a1bbd57033f57e7b6743621b79fcb9eb2ce3676",
        name: "Formation",
        category: "Gen Art",
        creator: "Jeff Davis",
        tokenIdRange: {
            start: "11000000",
            end: "11999999",
        },
    },
    {
        address: "0x229b1a62210c2329fe7a0ee67f517ae611789b35",
        name: "CIPHERS",
        category: "Gen Art",
        creator: "Per Kristian Stoveland",
    },
    {
        address: "0xaa39b261b8d4fdaa8a1ed436cc14a723c0480ee9",
        name: "Glitch",
        category: "Gen Art",
    },
    {
        address: "0x95864937cc8c90878c3254cf418632f8154d3b7d",
        name: "Quadrature",
        category: "Gen Art",
        creator: "Darien Brito",
    },
    {
        address: "0x9bf53d8c65f03d895dacaa776cc960e462ecb599",
        name: "Primera",
        category: "Gen Art",
        creator: "Mitchell and Yun",
    },
    {
        address: "0x0a1bbd57033f57e7b6743621b79fcb9eb2ce3676",
        name: "1935",
        category: "Gen Art",
        creator: "William Mapan",
        tokenIdRange: {
            start: "25000000",
            end: "25999999",
        },
    },
    {
        address: "0x99a9b7c1116f9ceeb1652de04d5969cce509b069",
        name: "Memories of Digital Data",
        category: "Gen Art",
        creator: "Kazuhiro Tanimoto",
        tokenIdRange: {
            start: "428000000",
            end: "428999999",
        },
    },
    {
        address: "0x2c7f335460fb9df460ff7ad6cc64cb7dd4064862",
        name: "BITFRAMES",
        category: "Gen Art",
    },

    // Photography Collections
    {
        address: "0x509a050f573be0d5e01a73c3726e17161729558b",
        name: "Where My Vans Go",
        category: "Photography",
    },
    // ... rest of Photography collections ...

    // AI Inspired Collections
    // ... AI Inspired collections ...

    // Memetics Collections
    // ... Memetics collections ...

    // Iconic Gems Collections
    {
        address: "0xd754937672300ae6708a51229112de4017810934",
        name: "DEAFBEEF Series 4",
        category: "Iconic Gems",
    },
    {
        address: "0x34eebee6942d8def3c125458d1a86e0a897fd6f9",
        name: "Checks VV",
        category: "Iconic Gems",
    },
    {
        address: "0x6339e5e072086621540d0362c4e3cea0d643e114",
        name: "Opepen",
        category: "Iconic Gems",
    },
    {
        address: "0xc3f733ca98e0dad0386979eb96fb1722a1a05e69",
        name: "Mooncats",
        category: "Iconic Gems",
    },
    {
        address: "0xdb7F99605FD3Cc23067c3d8c1bA637109f083dc2",
        name: "Doppelganger",
        category: "Iconic Gems",
    },
    {
        address: "0x6b6dd0c1aab55052bfaac891c3fb81a1cd7230ec",
        name: "Justin Aversano - Cognition",
        category: "Iconic Gems",
        creator: "Justin Aversano",
    },
    {
        address: "0xb92b8d7e45c0f197a8236c8345b86765250baf7c",
        name: "Asprey Bugatti La Voiture Noire Collection",
        category: "Iconic Gems",
    },
    {
        address: "0x5e86F887fF9676a58f25A6E057B7a6B8d65e1874",
        name: "Bitchcoin",
        category: "Iconic Gems",
    },
    {
        address: "0x7bd29408f11d2bfc23c34f18275bbf23bb716bc7",
        name: "MeeBits",
        category: "Iconic Gems",
    },
    {
        address: "0x12f28e2106ce8fd8464885b80ea865e98b465149",
        name: "Beeple Genesis",
        category: "Iconic Gems",
        creator: "Beeple",
    },
    {
        address: "0xb852c6b5892256c264cc2c888ea462189154d8d7",
        name: "rektguy",
        category: "Iconic Gems",
    },
    {
        address: "0x7487b35cc8902964599a6e5a90763a8e80f1395e",
        name: "Life In Japan Editions",
        category: "Iconic Gems",
        creator: "Grant Yun",
    },
    {
        address: "0xc17038437143b7d62f0bf861ccc154889d17efe9",
        name: "Beeple Everydays",
        category: "Iconic Gems",
        creator: "Beeple",
    },
    {
        address: "0xae1fb0cce66904b9fa2b60bef2b8057ce2441538",
        name: "REPLICATOR",
        category: "Iconic Gems",
        creator: "Mad Dog Jones",
        tokenIdRange: {
            start: "4295032833",
            end: "4295032833",
        },
    },
    {
        address: "0x082dcab372505ae56eafde58204ba5b12ff3f3f5",
        name: "Light Years",
        category: "Iconic Gems",
        creator: "Dmitri Cherniak",
    },
    {
        address: "0x8a939fd297fab7388d6e6c634eee3c863626be57",
        name: "xCopy",
        category: "Iconic Gems",
        creator: "XCOPY",
    },
    {
        address: "0xaadc2d4261199ce24a4b0a57370c4fcf43bb60aa",
        name: "The Currency",
        category: "Iconic Gems",
        creator: "Damien Hirst",
    },
    {
        address: "0x513cd71defc801b9c1aa763db47b5df223da77a2",
        name: "OSF's Red Lite District",
        category: "Iconic Gems",
    },
    {
        address: "0x1f493aa73c628259f755fd8b6540a3b4de3e994c",
        name: "Decal",
        category: "Iconic Gems",
        creator: "Reuben Wu",
    },
    {
        address: "0x6b00de202e3cd03c523ca05d8b47231dbdd9142b",
        name: "Tom Sachs: Rocket Factory - Rockets",
        category: "Iconic Gems",
        creator: "Tom Sachs",
    },
    {
        address: "0xc2c747e0f7004f9e8817db2ca4997657a7746928",
        name: "Hashmasks",
        category: "Iconic Gems",
    },
    {
        address: "0x68d0f6d1d99bb830e17ffaa8adb5bbed9d6eec2e",
        name: "Penthouse",
        category: "Iconic Gems",
        creator: "0xdgb",
        tokenIdRange: {
            start: "opensea-penthouse-by-0xdgb",
            end: "opensea-penthouse-by-0xdgb",
        },
    },
    {
        address: "0x33fd426905f149f8376e227d0c9d3340aad17af1",
        name: "6529Collections",
        category: "Iconic Gems",
    },
    {
        address: "0x34b45aad69b78bf5dc8cc2ac74d895f522a451a9",
        name: "Light Years: Process Works",
        category: "Iconic Gems",
        creator: "Dmitri Cherniak",
    },
    {
        address: "0x7afeda4c714e1c0a2a1248332c100924506ac8e6",
        name: "FVCK_CRYSTAL",
        category: "Iconic Gems",
    },
    {
        address: "0x2e55fb6e20e29344adb531200811007092051443",
        name: "Pop Wonder SuperRare",
        category: "Iconic Gems",
    },
    {
        address: "0xd754937672300ae6708a51229112de4017810934",
        name: "DeadBeef",
        category: "Iconic Gems",
        creator: "DEAFBEEF",
    },
    {
        address: "0xda1bf9b5de160cecde3f9304b187a2f5f5b83707",
        name: "CHRONOPHOTOGRAPH",
        category: "Iconic Gems",
        creator: "0xDEAFBEEF",
    },
    {
        address: "0x6f854b0c8c596128504eaff09eae53ca625bad90",
        name: "0xdgb Editions (2023)",
        category: "Iconic Gems",
        creator: "0xdgb",
    },
    {
        address: "0x495f947276749ce646f68ac8c248420045cb7b5e",
        name: "Pop Wonder OS",
        category: "Iconic Gems",
        tokenIdRange: {
            start: "opensea-pop-wonder-world",
            end: "opensea-pop-wonder-world",
        },
    },
    {
        address: "0xd92e44ac213b9ebda0178e1523cc0ce177b7fa96",
        name: "Beeple",
        category: "Iconic Gems",
        creator: "Beeple",
    },
    {
        address: "0xd1169e5349d1cb9941f3dcba135c8a4b9eacfdde",
        name: "Max Pain Xcopy",
        category: "Iconic Gems",
        creator: "XCOPY",
    },
    {
        address: "0xCcDF1373040D9Ca4B5BE1392d1945C1DaE4a862c",
        name: "Porsche",
        category: "Iconic Gems",
    },
    {
        address: "0x495f947276749ce646f68ac8c248420045cb7b5e",
        name: "SABET og",
        category: "Iconic Gems",
        creator: "SABET",
        tokenIdRange: {
            start: "opensea-sabet",
            end: "opensea-sabet",
        },
    },
    {
        address: "0xd90829c6c6012e4dde506bd95d7499a04b9a56de",
        name: "The Broken Keys",
        category: "Iconic Gems",
    },
    {
        address: "0xc0979e362143b7d62f0bf861ccc154889d17efe9",
        name: "Curious Cabins",
        category: "Iconic Gems",
    },
    {
        address: "0x0dbfb2640f0692dd96d6d66657a1eac816121f03",
        name: "Caravan",
        category: "Iconic Gems",
    },
    {
        address: "0x495f947276749ce646f68ac8c248420045cb7b5e",
        name: "Pop Wonder Editions",
        category: "Iconic Gems",
        tokenIdRange: {
            start: "opensea-pop-wonder-editions",
            end: "opensea-pop-wonder-editions",
        },
    },
    {
        address: "0x09b0ef6e8ef63db4be5df9e20b5f4fd3e3b92dac",
        name: "Porsche Pioneers",
        category: "Iconic Gems",
    },
    {
        address: "0x0cf3da2732ae7f078f8400c7325496774761d098",
        name: "Daniloff",
        category: "Iconic Gems",
    },
    {
        address: "0x4f96a7116a4c2391fdaf239d2fb7260ac2fc0545",
        name: "Cath behind the scenes",
        category: "Iconic Gems",
    },
    {
        address: "0xe8554c1362ffedc2664645a9a90be54a08ee1b44",
        name: "Blue Patagonia",
        category: "Iconic Gems",
    },
    {
        address: "0x1ac8acb916fd62b5ed35587a10d64cdfc940a271",
        name: "Night Vision Series",
        category: "Iconic Gems",
        creator: "Jake Fried",
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Running Moon",
        category: "Iconic Gems",
        creator: "Licia He",
        tokenIdRange: {
            start: "334000000",
            end: "334999999",
        },
    },
    {
        address: "0x4d928ab507bf633dd8e68024a1fb4c99316bbdf3",
        name: "LOVE Tennis Art Project",
        category: "Iconic Gems",
        creator: "Martin Grasser",
    },
    {
        address: "0xd1169e5349d1cb9941f3dcba135c8a4b9eacfdde",
        name: "MAX PAIN AND FRENS",
        category: "Iconic Gems",
        creator: "XCOPY",
    },
    {
        address: "0x34eebee6942d8def3c125458d1a86e0a897fd6f9",
        name: "Checks - VV Edition",
        category: "Iconic Gems",
    },
    {
        address: "0x6339e5e072086621540d0362c4e3cea0d643e114",
        name: "Opepen Edition",
        category: "Iconic Gems",
    },
    {
        address: "0xefec8fb24b41b9ea9c594eb7956aadcc6dd0490f",
        name: "Vibes",
        category: "Iconic Gems",
        creator: "Amber Vittoria",
    },
    {
        address: "0x8cdbd7010bd197848e95c1fd7f6e870aac9b0d3c",
        name: "Trademark",
        category: "Iconic Gems",
        creator: "Jack Butcher",
        tokenIdRange: {
            start: "4000000",
            end: "4999999",
        },
    },
    {
        address: "0x8cdbd7010bd197848e95c1fd7f6e870aac9b0d3c",
        name: "Signature",
        category: "Iconic Gems",
        creator: "Jack Butcher",
        tokenIdRange: {
            start: "3000000",
            end: "3999999",
        },
    },
    {
        address: "0xda6558fa1c2452938168ef79dfd29c45aba8a32b",
        name: "LUCI: Chapter 5 - The Monument Game",
        category: "Iconic Gems",
        creator: "Sam Spratt",
    },
    {
        address: "0xdfea2b364db868b1d2601d6b833d74db4de94460",
        name: "REMNANTS",
        category: "Iconic Gems",
    },
    {
        address: "0x16edf9d65a54e1617921a8125d77ef48c4e8c449",
        name: "Monster Soup",
        category: "Iconic Gems",
        creator: "Des Lucrece",
    },
    {
        address: "0x5116edd4ac94d6aeb54b5a1533ca51a7e0c86807",
        name: "Station3 Patron",
        category: "Iconic Gems",
    },
    {
        address: "0xe77ad290adab2989a81ae62ab2467c01b45feeff",
        name: "Proceed w/ Caution",
        category: "Iconic Gems",
    },
    {
        address: "0xb2e6951a52d38814ed3ce2f4b9bec26091304747",
        name: "Ackstract Editions",
        category: "Iconic Gems",
    },
    {
        address: "0x25b834999ea471429ee211e2d465e85adae0ce14",
        name: "batz editions",
        category: "Iconic Gems",
    },
    {
        address: "0xb41e9aa79bda9890e9c74127d2af0aa610606aed",
        name: "EXIF",
        category: "Iconic Gems",
        creator: "Guido Di Salle",
    },
    {
        address: "0x720786231ddf158ebd23bd590f73b29bff78d783",
        name: "Strands of Solitude",
        category: "Iconic Gems",
        creator: "William Mapan",
    },
    {
        address: "0x8bd8eab9655573165fdafa404e72dc5e769a83fa",
        name: "Alternate",
        category: "Iconic Gems",
        creator: "Kim Asendorf",
    },
    {
        address: "0x379b5616a6afe6bc6baa490ef8fd98bf6d7db45c",
        name: "Checks - VV Elements",
        category: "Iconic Gems",
    },
    {
        address: "0xa94161fbe69e08ff5a36dfafa61bdf29dd2fb928",
        name: "Voxelglyph",
        category: "Iconic Gems",
    },
    {
        address: "0x026224a2940bfe258d0dbe947919b62fe321f042",
        name: "lobsterdao",
        category: "Iconic Gems",
    },
    {
        address: "0x36f4d96fe0d4eb33cdc2dc6c0bca15b9cdd0d648",
        name: "gmDAO",
        category: "Iconic Gems",
    },
    {
        address: "0xfd6a5540ad049853420c42bbd46c01fd5c9e5f5a",
        name: "Interwoven",
        category: "Iconic Gems",
        creator: "Emily Xie",
    },
    {
        address: "0xd32938e992a1821b6441318061136c83ea715ba1",
        name: "Formation",
        category: "Iconic Gems",
        creator: "Harto",
    },
    {
        address: "0x4b33a369a9b4ff51bfc0a7267e30940507b81d84",
        name: "Distance",
        category: "Iconic Gems",
        creator: "William Mapan",
    },
    {
        address: "0x9f803635a5af311d9a3b73132482a95eb540f71a",
        name: "The Great Color Study",
        category: "Iconic Gems",
    },
    {
        address: "0x36f20faf3785d226bf5478f9b271a7077859b5a9",
        name: "SquiggleDAO",
        category: "Iconic Gems",
    },
    {
        address: "0xb034fa4ba0a5cca4bd9f5b9db845fb26c5500b8c",
        name: "Decal",
        category: "Iconic Gems",
        creator: "XCOPY",
    },
    {
        address: "0x186e2eece5ddbac8f1dde73723586b2c86aa8b58",
        name: "ACID PEPES",
        category: "Iconic Gems",
        creator: "LORS",
    },
    {
        address: "0xbf476fad7e4ae2d679e9e739d3704a890f53c2a2",
        name: "Now Pass",
        category: "Iconic Gems",
    },
    {
        address: "0x66293a9b1339ca99623e82bc71f88d767f60ad21",
        name: "Catharsis",
        category: "Iconic Gems",
        creator: "Dario Lanza",
    },
    {
        address: "0xc23a563a26afff06e945ace77173e1568f288ce5",
        name: "OSF Editions Season 1",
        category: "Iconic Gems",
    },
    {
        address: "0x27787755137863bb7f2387ed34942543c9f24efe",
        name: "Factura",
        category: "Iconic Gems",
        creator: "Mathias Isaksen",
    },
    {
        address: "0x8eaa9ae1ac89b1c8c8a8104d08c045f78aadb42d",
        name: "Tableland Rigs",
        category: "Iconic Gems",
    },
    {
        address: "0x495f947276749ce646f68ac8c248420045cb7b5e",
        name: "Cozy Homes",
        category: "Iconic Gems",
        creator: "Grant Yun",
        tokenIdRange: {
            start: "opensea-cozyhomes",
            end: "opensea-cozyhomes",
        },
    },
    {
        address: "0xd3f9551e9bc926cc180ac8d3e27364f4081df624",
        name: "servants of the Muse",
        category: "Iconic Gems",
    },
    {
        address: "0xd752ad52ab60e58960e8a193c037383ffce8dd70",
        name: "Open Eyes (Signal)",
        category: "Iconic Gems",
        creator: "Jake Fried",
    },
    {
        address: "0xbd874d3d6c27f1d3156001e5df38a3dfdd3dbcf8",
        name: "alterego",
        category: "Iconic Gems",
        creator: "Russell Young",
    },
    {
        address: "0xd93eb3bcd333d934b5c18f28fee3ab72b2aec5af",
        name: "ripcache",
        category: "Iconic Gems",
    },
    {
        address: "0x3c72d904a2006c02e4ebdbab32477e9182d9e59d",
        name: "Warothys",
        category: "Iconic Gems",
    },
    {
        address: "0x49129a186169ecebf3c1ab036d99d4ecb9a95c67",
        name: "The Flowers Project",
        category: "Iconic Gems",
    },
    {
        address: "0x7e9b9ba1a3b4873279857056279cef6a4fcdf340",
        name: "Noble Gallery",
        category: "Iconic Gems",
    },
    {
        address: "0x055f16af0c61aa67176224d8c2407c9a5628bcca",
        name: "archive edition",
        category: "Iconic Gems",
    },
    {
        address: "0x31237f02f9b7ffc22ea7a9d9649520c0833d16f4",
        name: "Amber Vittoria's Artwork",
        category: "Iconic Gems",
        creator: "Amber Vittoria",
    },
    {
        address: "0x05218d1744caf09190f72333f9167ce12d18af5c",
        name: "Memories Of A Masterpiece",
        category: "Iconic Gems",
    },
    {
        address: "0x1067b71aac9e2f2b1a4e6ab6c1ed10510876924a",
        name: "24 Hours of Art",
        category: "Iconic Gems",
    },
    {
        address: "0x5b9e53848d28db2295f5d25ae634c4f7711a2216",
        name: "Two Worlds",
        category: "Iconic Gems",
        creator: "Jeremy Booth & Orkhan Isayev",
    },
    {
        address: "0x495f947276749ce646f68ac8c248420045cb7b5e",
        name: "It's Because You're Pretty",
        category: "Iconic Gems",
        creator: "Amber Vittoria",
        tokenIdRange: {
            start: "opensea-amber-vittoria-pretty",
            end: "opensea-amber-vittoria-pretty",
        },
    },
    {
        address: "0x5ab44d97b0504ed90b8c5b8a325aa61376703c88",
        name: "E30D",
        category: "Iconic Gems",
        creator: "glitch gallery",
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "Incomplete Control",
        category: "Iconic Gems",
        creator: "Tyler Hobbs",
        tokenIdRange: {
            start: "228000000",
            end: "228999999",
        },
    },
    {
        address: "0x059edd72cd353df5106d2b9cc5ab83a52287ac3a",
        name: "Chromie Squiggle",
        category: "Iconic Gems",
        creator: "Snowfro",
        tokenIdRange: {
            start: "0",
            end: "999999",
        },
    },
    {
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        name: "The Eternal Pump",
        category: "Iconic Gems",
        creator: "Dmitri Cherniak",
        tokenIdRange: {
            start: "22000000",
            end: "22999999",
        },
    },
    {
        address: "0x112bec51a4b0942e7f7b2a5090f5ad57b7901559",
        name: "TechnOrigami",
        category: "Iconic Gems",
    },
    {
        address: "0xc3c415be22282859fbfc04ddd382685dfe7ed7f8",
        name: "Decal",
        category: "Iconic Gems",
        creator: "Grant Yun",
    },
    {
        address: "0x9d63898298310c225de30ae9da0f0b738a7b7005",
        name: "Samsung MX1 ART COLLECTION",
        category: "Iconic Gems",
    },
    {
        address: "0xd4a6669e4787f23a2f711e0b6c6fb5431ce1594e",
        name: "Geometries",
        category: "Iconic Gems",
        creator: "Frank Stella",
    },
    {
        address: "0xb932a70a57673d89f4acffbe830e8ed7f75fb9e0",
        name: "SuperRare 1/1s: Dimitri Daniloff",
        category: "Iconic Gems",
        creator: "Dimitri Daniloff",
        tokenIdRange: {
            start: "superrare-shared-0xf9789dce5346c367c68ad0abcc2e38928d12dd9d",
            end: "superrare-shared-0xf9789dce5346c367c68ad0abcc2e38928d12dd9d",
        },
    },
    {
        address: "0x0483b0dfc6c78062b9e999a82ffb795925381415",
        name: "Orbit",
        category: "Iconic Gems",
        creator: "Jiannan Huang",
    },
    {
        address: "0x68d0f6d1d99bb830e17ffaa8adb5bbed9d6eec2e",
        name: "Solitaire",
        category: "Iconic Gems",
        creator: "Terrell Jones",
        tokenIdRange: {
            start: "opensea-solitaire-by-terrell-jones",
            end: "opensea-solitaire-by-terrell-jones",
        },
    },
    {
        address: "0x92ed200771647b26a5ea72737f1ba9a7366e471e",
        name: "An Old Soul",
        category: "Iconic Gems",
    },
    {
        address: "0xb932a70a57673d89f4acffbe830e8ed7f75fb9e0",
        name: "SuperRare 1/1s: Brendan North",
        category: "Iconic Gems",
        creator: "Brendan North",
        tokenIdRange: {
            start: "superrare-shared-0x077bfc14dd6725f260e1abfd5c942ee13a27091b",
            end: "superrare-shared-0x077bfc14dd6725f260e1abfd5c942ee13a27091b",
        },
    },
    {
        address: "0x3e34ff1790bf0a13efd7d77e75870cb525687338",
        name: "DAMAGE CONTROL",
        category: "Iconic Gems",
        creator: "XCOPY",
    },
    {
        address: "0x8d9b2560bf173603b680c7c4780397775ddea09c",
        name: "Pop Wonder Editions",
        category: "Iconic Gems",
    },
    {
        address: "0xbc5dc6e819a5ff4686af6fb9b1550b5cabb3a58d",
        name: "FVCKRENDER ARCHIVE",
        category: "Iconic Gems",
        creator: "FVCKRENDER",
    },
    {
        address: "0xc8bdf7c6e22930b8e8e1007ffc55be59b239ea93",
        name: "Earth Iterations",
        category: "Iconic Gems",
    },
    {
        address: "0x484e5155ae4b277cdb7f13a80ab3f627ff491149",
        name: "Legalize Ground Beef",
        category: "Iconic Gems",
    },
    {
        address: "0xbe39273b36c7bb971fed88c5f2a093270e0267e0",
        name: "BODY MACHINE (MERIDIANS)",
        category: "Iconic Gems",
        creator: "Sougwen Chung",
    },
    {
        address: "0xcce4727300f460719588be90f7069c6f7b82748f",
        name: "Edouard et Bastien",
        category: "Iconic Gems",
    },
    {
        address: "0xc9976839b3db2e96e58abfbf4e42925d0656ec27",
        name: "Edouard et Bastien",
        category: "Iconic Gems",
    },
    {
        address: "0xbead5e1bd976bd8b27bd54ed50328e7364ea77bd",
        name: "NORTH STAR",
        category: "Iconic Gems",
        creator: "Jake Fried",
    },
    {
        address: "0x6c646767b605e561846e7a4e8ee7afefe0af476c",
        name: "The Cameras",
        category: "Iconic Gems",
    },
    {
        address: "0xc04e0000726ed7c5b9f0045bc0c4806321bc6c65",
        name: "ICXN",
        category: "Iconic Gems",
    },
];

// Export helper functions
export {
    isCuratedCollection,
    getCuratedCollection,
    getCuratedAddresses,
    getFeaturedAddresses,
    getVerifiedAddresses,
} from "./collections";

// Define CollectionCategory as a type
type CollectionCategory = string;

// Helper functions
export function getCollectionsByCategory(
    category: CollectionCategory
): CuratedCollection[] {
    return CURATED_COLLECTIONS.filter(
        (collection) => collection.category === category
    );
}

export function getCategoryCount(category: CollectionCategory): number {
    return getCollectionsByCategory(category).length;
}

export function getAllCategories(): CollectionCategory[] {
    return [
        ...new Set(
            CURATED_COLLECTIONS.map((collection) => collection.category)
        ),
    ];
}

export function getCollectionsByCreator(creator: string): CuratedCollection[] {
    return CURATED_COLLECTIONS.filter(
        (collection) =>
            collection.creator?.toLowerCase() === creator.toLowerCase()
    );
}

// Create a map for quick lookups
export const COLLECTIONS_BY_ADDRESS = new Map<string, CuratedCollection>(
    CURATED_COLLECTIONS.map((collection) => [
        collection.address.toLowerCase(),
        collection,
    ])
);

// URL and viewing helpers
export const IKIGAI_BASE_URL = "https://ikigailabs.xyz/ethereum";

export interface CollectionViewOptions {
    sortBy?:
        | "floor_asc"
        | "floor_desc"
        | "volume_asc"
        | "volume_desc"
        | "created_asc"
        | "created_desc";
    filterBy?: "listed" | "all";
}

export function getCollectionUrl(
    address: string,
    collection?: CuratedCollection
): string {
    if (!collection) {
        collection = COLLECTIONS_BY_ADDRESS.get(address.toLowerCase());
    }

    let url = `${IKIGAI_BASE_URL}/${address}`;

    // If collection has tokenIdRange, append it to the URL
    if (collection?.tokenIdRange?.start && collection?.tokenIdRange?.end) {
        url += `:${collection.tokenIdRange.start}:${collection.tokenIdRange.end}`;
    }

    return url;
}

export function getCollectionViewUrl(
    address: string,
    options?: CollectionViewOptions
): string {
    const collection = COLLECTIONS_BY_ADDRESS.get(address.toLowerCase());
    const baseUrl = getCollectionUrl(address, collection);
    if (!options) return baseUrl;

    const params = new URLSearchParams();
    if (options.sortBy) params.append("sort", options.sortBy);
    if (options.filterBy) params.append("filter", options.filterBy);

    return `${baseUrl}?${params.toString()}`;
}

// Helper to get URLs for all collections in a category
export function getCategoryUrls(category: CollectionCategory): string[] {
    return getCollectionsByCategory(category).map((collection) =>
        getCollectionUrl(collection.address, collection)
    );
}

// Helper to get URLs for collections by a specific creator
export function getCreatorCollectionUrls(creator: string): string[] {
    return getCollectionsByCreator(creator).map((collection) =>
        getCollectionUrl(collection.address, collection)
    );
}

// Helper to get a formatted collection view with URL
export function getCollectionView(address: string): {
    collection: CuratedCollection | undefined;
    url: string;
} {
    const collection = COLLECTIONS_BY_ADDRESS.get(address.toLowerCase());
    return {
        collection,
        url: getCollectionUrl(address, collection),
    };
}

// Helper to get multiple collection views
export function getCollectionViews(addresses: string[]): {
    collection: CuratedCollection | undefined;
    url: string;
}[] {
    return addresses.map((address) => getCollectionView(address));
}

// Helper to get all collections in a category with their URLs
export function getCategoryCollectionViews(category: CollectionCategory): {
    collection: CuratedCollection;
    url: string;
}[] {
    return getCollectionsByCategory(category).map((collection) => ({
        collection,
        url: getCollectionUrl(collection.address, collection),
    }));
}

// Helper to format collection data for display
export function formatCollectionData(collection: CuratedCollection): string {
    const url = getCollectionUrl(collection.address, collection);
    return `
Collection: ${collection.name}
Category: ${collection.category}
${collection.creator ? `Creator: ${collection.creator}` : ""}
View on IkigaiLabs: ${url}
${collection.tokenIdRange ? `Token Range: ${collection.tokenIdRange.start || "0"} - ${collection.tokenIdRange.end || "unlimited"}` : ""}
`;
}

// Helper to get a shareable collection link with optional sort/filter
export function getShareableCollectionLink(
    address: string,
    options?: CollectionViewOptions
): string {
    const url = getCollectionViewUrl(address, options);
    return `View this NFT collection on IkigaiLabs: ${url}`;
}

// Set of curated collection addresses (lowercase)
export const curatedCollections = new Set<string>([
    // Add your curated collection addresses here
    // Example:
    // "0x1234...".toLowerCase(),
]);
