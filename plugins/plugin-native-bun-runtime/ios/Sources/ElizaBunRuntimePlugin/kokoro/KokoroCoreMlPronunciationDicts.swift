import Foundation

/// Pronunciation dictionaries for Kokoro TTS multilingual support.
///
/// Large dictionaries (French, Portuguese, Hindi) are loaded from JSON resource
/// files at runtime. Smaller ones (Spanish, Italian, German, Korean) are
/// embedded as Swift literals. Source: ipa-dict (MIT, open-dict-data/ipa-dict)
/// and standard phonetic references.
enum PronunciationDicts {

    // MARK: - JSON Resource Loading

    private static func loadJSON(_ name: String) -> [String: String] {
        let url = Bundle.main.url(forResource: name, withExtension: "json")
            ?? Bundle.main.url(forResource: name, withExtension: "json", subdirectory: "KokoroTTS")
        guard let url else { return [:] }
        guard let data = try? Data(contentsOf: url),
              let dict = try? JSONDecoder().decode([String: String].self, from: data) else {
            return [:]
        }
        return dict
    }

    // MARK: - French (3093 entries, JSON)

    static let fr: [String: String] = loadJSON("dict_fr")

    // MARK: - Portuguese (2001 entries, JSON)

    static let pt: [String: String] = loadJSON("dict_pt")

    // MARK: - Hindi (146 entries, JSON)

    static let hi: [String: String] = loadJSON("dict_hi")

    // MARK: - Spanish (125 entries)

    static let es: [String: String] = [
        "adiós": "aðjˈos", "agua": "ˈaɣwa", "ahora": "aˈoɾa", "al": "ˈal",
        "alto": "ˈalto", "amarillo": "ˌamaɾˈiʎo", "amigo": "amˈiɣo",
        "antes": "ˈantes", "aquí": "akˈi", "azul": "aθˈul", "año": "ˈaɲo",
        "bajo": "bˈaxo", "bien": "bjˈen", "blanco": "blˈanko", "boca": "bˈoka",
        "brazo": "bɾˈaθo", "bueno": "bwˈeno", "buenos": "bwˈenos",
        "cabeza": "kaβˈeθa", "café": "kafˈe", "calle": "kˈaʎe", "casa": "kˈasa",
        "cinco": "θˈinko", "ciudad": "θjuðˈad", "comida": "komˈiða",
        "como": "kˈomo", "con": "kˈon", "corazón": "kˌoɾaθˈon", "cosa": "kˈosa",
        "cuando": "kwˈando", "cuatro": "kwˈatɾo", "dar": "dˈaɾ", "de": "dˈe",
        "decir": "deθˈiɾ", "del": "dˈel", "desde": "dˈesðe", "después": "despwˈes",
        "donde": "dˈonde", "dos": "dˈos", "día": "dˈia", "días": "dˈias",
        "el": "ˈel", "ella": "ˈeʎa", "ellas": "ˈeʎas", "ellos": "ˈeʎos",
        "en": "ˈen", "entre": "ˈɛntɾe", "eso": "ˈeso", "estar": "estˈaɾ",
        "esto": "ˈesto", "familia": "famˈilja", "gracias": "ɡɾˈaθjas",
        "grande": "ɡɾˈande", "haber": "aβˈeɾ", "hacer": "aθˈeɾ", "hasta": "ˈasta",
        "hermana": "eɾmˈana", "hermano": "eɾmˈano", "hija": "ˈixa",
        "hijo": "ˈixo", "hola": "ˈola", "hombre": "ˈombɾe", "ir": "ˈiɾ",
        "joven": "xˈoβen", "la": "lˈa", "las": "lˈas", "leche": "lˈetʃe",
        "llegar": "ʎeɣˈaɾ", "los": "lˈos", "madre": "mˈaðɾe", "malo": "mˈalo",
        "mano": "mˈano", "mesa": "mˈesa", "mujer": "muxˈeɾ", "mundo": "mˈundo",
        "muy": "mˈuj", "más": "mˈas", "negro": "nˈeɣɾo", "niña": "nˈiɲa",
        "niño": "nˈiɲo", "no": "nˈo", "nosotros": "nosˈotɾos", "nuevo": "nwˈeβo",
        "nunca": "nˈunka", "ojo": "ˈoxo", "padre": "pˈaðɾe", "pan": "pˈan",
        "para": "pˈaɾa", "país": "paˈis", "pequeño": "pekˈeɲo",
        "perdón": "peɾðˈon", "pero": "pˈeɾo", "pie": "pjˈe", "poder": "poðˈeɾ",
        "por": "pˈoɾ", "porque": "pˈoɾke", "prueba": "pɾuˈeβa",
        "puerta": "pwˈeɾta", "querer": "keɾˈeɾ", "qué": "kˈe", "rojo": "rˈoxo",
        "saber": "saβˈeɾ", "ser": "sˈer", "siempre": "sjˈempɾe", "sin": "sˈin",
        "sobre": "sˈoβɾe", "sí": "sˈi", "también": "tambjˈen", "tener": "tenˈeɾ",
        "tiempo": "tjˈempo", "todo": "tˈoðo", "tres": "tɾˈes", "tú": "tˈu",
        "un": "ˈun", "una": "ˈuna", "uno": "ˈuno", "usted": "ustˈed",
        "ventana": "bentˈana", "ver": "bˈeɾ", "verde": "bˈeɾðe", "vida": "bˈiða",
        "viejo": "bjˈexo", "vino": "bˈino", "yo": "ʝˈo", "él": "ˈel",
    ]

    // MARK: - Italian (174 entries)

    static let it: [String: String] = [
        "acqua": "ˈakːwa", "alto": "ˈalto", "altro": "ˈaltro", "amico": "amˈiko",
        "anche": "ˈanke", "andare": "andˈare", "anno": "ˈanno", "avere": "avˈere",
        "bambina": "bambˈina", "bambino": "bambˈino", "basso": "bˈasso",
        "bella": "bˈɛlla", "bello": "bˈɛllo", "bene": "bˈɛne", "bere": "bˈere",
        "bianco": "bjˈanko", "blu": "blˈu", "bocca": "bˈokːa",
        "braccio": "brˈatʃːo", "brutto": "brˈutːo", "buonasera": "bwˌɔnasˈera",
        "buongiorno": "bʊondʒˈɔrno", "buono": "bʊˈɔno", "caffè": "kaffˈɛ",
        "caldo": "kˈaldo", "casa": "kˈaza", "cattivo": "katːˈivo", "che": "kˈe",
        "chi": "kˈi", "ciao": "tʃˈao", "cibo": "tʃˈibo", "cinque": "tʃˈinkwe",
        "città": "tʃitːˈa", "come": "kˈome", "cosa": "kˈɔza", "cuore": "kʊˈɔre",
        "dal": "dˈal", "dalla": "dˈalla", "dare": "dˈare", "debole": "dˈebole",
        "dei": "dˈeɪ", "del": "dˈel", "della": "dˈella", "delle": "dˈelle",
        "dello": "dˈello", "di": "dˈi", "dieci": "djˈɛtʃɪ", "dire": "dˈire",
        "domani": "domˈanɪ", "donna": "dˈɔnna", "dopo": "dˈopo",
        "dormire": "dormˈire", "dove": "dˈove", "dovere": "dovˈere", "due": "dˈue",
        "erano": "ˈɛrano", "essere": "ˈɛssere", "famiglia": "famˈiʎa",
        "fare": "fˈare", "felice": "felˈitʃe", "figlia": "fˈiʎa",
        "figlio": "fˈiʎo", "finestra": "finˈɛstra", "forte": "fˈɔrte",
        "fratello": "fratˈɛllo", "freddo": "frˈedːo", "gamba": "ɡˈamba",
        "giallo": "dʒˈallo", "giorno": "dʒˈorno", "giovane": "dʒˈovane",
        "gli": "ʎˈɪ", "grande": "ɡrˈande", "grazie": "ɡrˈatsje",
        "ieri": "jˈɛrɪ", "il": "ˈiːl", "io": "ˈio", "la": "lˈa",
        "latte": "lˈatːe", "le": "lˈe", "leggere": "lˈɛdʒːere", "lei": "lˈɛi",
        "lo": "lˈo", "loro": "lˈɔro", "lui": "lˈui", "lungo": "lˈuŋɡo",
        "ma": "mˈa", "madre": "mˈadre", "mai": "mˈaj", "mangiare": "mandʒˈare",
        "mano": "mˈano", "mattina": "matːˈina", "migliore": "miʎˈore",
        "molto": "mˈolto", "mondo": "mˈondo", "nero": "nˈero", "noi": "nˈoi",
        "non": "nˈon", "notte": "nˈɔtːe", "nove": "nˈɔve", "nuovo": "nʊˈɔvo",
        "occhio": "ˈɔkːio", "oggi": "ˈɔdʒːɪ", "ogni": "ˈoɲɲɪ", "ora": "ˈora",
        "otto": "ˈɔtːo", "padre": "pˈadre", "paese": "paˈeze", "pane": "pˈane",
        "parlare": "parlˈare", "peggiore": "pedʒːˈore", "pensare": "pensˈare",
        "perché": "perkˈe", "piccolo": "pˈikːolo", "piede": "pjˈɛde",
        "più": "pjˈu", "porta": "pˈɔrta", "potere": "potˈere", "prego": "prˈɛɡo",
        "prima": "prˈima", "primo": "prˈimo", "prova": "prˈɔva",
        "quale": "kwˈale", "quando": "kwˈando", "quanto": "kwˈanto",
        "quattro": "kwˈatːro", "quello": "kwˈello", "questa": "kwˈesta",
        "questo": "kwˈesto", "qui": "kwˈi", "rosso": "rˈosso",
        "sapere": "sapˈere", "scrivere": "skrˈivere", "scusi": "skˈuzɪ",
        "secondo": "sekˈondo", "sedia": "sˈɛdia", "sei": "sˈɛi",
        "sempre": "sˈɛmpre", "sentire": "sentˈire", "sera": "sˈera",
        "sette": "sˈɛtːe", "siamo": "sjˈamo", "siete": "sjˈete",
        "sole": "sˈole", "sono": "sˈono", "sorella": "sorˈɛlla",
        "splende": "splˈɛnde", "stare": "stˈare", "stata": "stˈata",
        "stato": "stˈato", "stesso": "stˈesso", "strada": "strˈada",
        "sì": "sˈiː", "tavola": "tˈavola", "tempo": "tˈɛmpo",
        "terzo": "tˈɛrtso", "testa": "tˈɛsta", "tre": "trˈe",
        "triste": "trˈiste", "tu": "tˈu", "tutto": "tˈutːo",
        "ultimo": "ˈultimo", "un": "ˈun", "una": "ˈuna", "uno": "ˈuno",
        "uomo": "wˈɔmo", "vecchio": "vˈɛkːio", "vedere": "vedˈere",
        "venire": "venˈire", "verde": "vˈerde", "vino": "vˈino",
        "vita": "vˈita", "voi": "vˈoi", "volere": "volˈere", "è": "ˈɛː",
    ]


}
