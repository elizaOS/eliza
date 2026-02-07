/*
    Real YARA Rules: JavaScript Obfuscation Detection

    These rules detect common JavaScript obfuscation patterns used by malware.
    They demonstrate best practices for JavaScript/browser malware:
    - Targeting obfuscator-specific signatures
    - Using occurrence counts for density-based detection
    - Combining multiple weak indicators into strong detection

    Sources:
    - imp0rtp3/js-yara-rules: obfuscator.io patterns
    - Nils Kuhnert: SocGholish patterns
    - Josh Trombley: SocGholish inject patterns

    Attribution: @imp0rtp3, Nils Kuhnert, Josh Trombley
*/

rule SUSP_JS_Obfuscator_IO
{
    meta:
        description = "Detects JavaScript obfuscated by obfuscator.io (common in malware)"
        author = "@imp0rtp3 (adapted)"
        reference = "https://github.com/imp0rtp3/js-yara-rules"
        date = "2021-01-01"
        modified = "2025-01-30"
        score = 60

    strings:
        // Beginning of obfuscated script - variable naming pattern
        $start1 = "var a0_0x" ascii
        $start2 = /var _0x[a-f0-9]{4}/ ascii

        // Obfuscator.io specific function call patterns
        $pattern1 = /a0_0x([a-f0-9]{2}){2,4}\('?0x[0-9a-f]{1,3}'?\)/
        $pattern2 = /_0x([a-f0-9]{2}){2,4}\('?0x[0-9a-f]{1,3}'?\)/
        $pattern3 = /_0x([a-f0-9]{2}){2,4}\['push'\]\(_0x([a-f0-9]{2}){2,4}\['shift'\]\(\)\)/

        // Common obfuscator.io code patterns
        $code1 = "))),function(){try{var _0x" ascii
        $code2 = "['atob']=function(" ascii
        $code3 = ")['replace'](/=+$/,'');var" ascii
        $code4 = "return!![]" ascii
        $code5 = "while(!![])" ascii

    condition:
        filesize < 1MB and
        (
            // Script starts with obfuscator pattern
            $start1 at 0 or
            $start2 at 0 or

            // High density of obfuscated function calls
            (#pattern1 + #pattern2) > (filesize \ 200) or
            #pattern3 > 1 or

            // Multiple obfuscator code patterns
            3 of ($code*)
        )
}

rule MAL_JS_SocGholish_Dropper
{
    meta:
        description = "Detects SocGholish fake update JavaScript dropper via ActiveX and bracket notation patterns"
        author = "Nils Kuhnert (adapted)"
        reference = "https://github.com/imp0rtp3/js-yara-rules"
        date = "2021-03-29"
        modified = "2025-01-30"
        hash1 = "7ccbdcde5a9b30f8b2b866a5ca173063dec7bc92034e7cf10e3eebff017f3c23"
        score = 85

    strings:
        // Must start with try block (SocGholish signature)
        // Note: Short string, but position-anchored in condition
        $try_block = "try{" ascii

        // ActiveX object creation (Windows-specific)
        $ax1 = "new ActiveXObject('Scripting.FileSystemObject');" ascii
        $ax2 = "new ActiveXObject('MSXML2.XMLHTTP')" ascii

        // Bracket notation to evade detection
        $brack1 = "['DeleteFile']" ascii
        $brack2 = "['WScript']['ScriptFullName']" ascii
        $brack3 = "['WScript']['Sleep'](1000)" ascii
        $brack4 = "this['eval']" ascii
        $brack5 = "String['fromCharCode']" ascii

        // Magic numbers used in decoding
        $magic1 = "2), 16)," ascii
        $magic2 = "= 103," ascii
        $magic3 = "'00000000'" ascii

    condition:
        // SocGholish starts with "try{" block
        $try_block in (0..10) and

        // Typical size range for SocGholish dropper
        filesize > 3KB and filesize < 5KB and

        // Need most of these patterns
        8 of ($ax*, $brack*, $magic*)
}

rule SUSP_JS_Inject_ScriptLoader
{
    meta:
        description = "Detects JavaScript injection patterns that load external scripts"
        author = "Josh Trombley (adapted)"
        reference = "https://github.com/imp0rtp3/js-yara-rules"
        date = "2021-09-02"
        modified = "2025-01-30"
        score = 55

    strings:
        // Dynamic script element creation
        $create = "document.createElement('script')" ascii
        $type = "type = 'text/javascript'" ascii nocase

        // DOM injection
        $get_scripts = "document.getElementsByTagName('script')" ascii
        $insert = ".parentNode.insertBefore(" ascii

        // Decoding patterns
        $atob = "=window.atob(" ascii
        $regex = "new RegExp(" ascii

    condition:
        filesize < 500KB and
        all of them
}

rule SUSP_JS_Base64Encoded_Payload
{
    meta:
        description = "Detects JavaScript with base64-encoded payloads commonly used in injection attacks"
        author = "Josh Trombley (adapted)"
        reference = "https://github.com/imp0rtp3/js-yara-rules"
        date = "2021-09-02"
        modified = "2025-01-30"
        score = 50

    strings:
        // Base64 strings commonly found in SocGholish injections
        // These decode to browser detection/injection strings
        $b64_referrer = "cmVmZXJyZXI=" ascii          // "referrer"
        $b64_useragent = "dXNlckFnZW50" ascii         // "userAgent"
        $b64_localStorage = "bG9jYWxTdG9yYWdl" ascii  // "localStorage"
        $b64_windows = "V2luZG93cw==" ascii           // "Windows"
        $b64_href = "aHJlZg==" ascii                  // "href"
        $b64_android = "QW5kcm9pZA==" ascii           // "Android"

    condition:
        filesize < 500KB and
        4 of them
}

rule SUSP_JS_EvalDecode_Chain
{
    meta:
        description = "Detects eval + decode chains commonly used in JavaScript malware"
        author = "Trail of Bits"
        reference = "https://blog.malwarebytes.com/threat-analysis/2020/10/kraken-attack-uses-eval-to-execute-javascript/"
        date = "2025-01-30"
        score = 65

    strings:
        // eval + atob (base64 decode)
        $eval_atob = /eval\s*\(\s*atob\s*\(/ nocase

        // eval + fromCharCode
        $eval_charcode = /eval\s*\(\s*String\.fromCharCode/ nocase

        // eval + unescape
        $eval_unescape = /eval\s*\(\s*unescape\s*\(/ nocase

        // Function constructor (alternative to eval)
        $func_constructor = /Function\s*\(\s*['"]return/ nocase

        // Multiple decode stages
        $multi_decode = /atob\s*\([^)]+atob\s*\(/ nocase

    condition:
        filesize < 1MB and
        2 of them
}
