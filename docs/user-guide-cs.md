# Uživatelský návod — lokální verze

## Požadavky

- Debian/Linux, Python 3.10 nebo novější a Node.js 20 nebo novější.
- `pandas` dostupné ve výchozím příkazu `python3`. Je to jediná přímá Python závislost aplikace.
- npm, kterým se instalují Node balíčky `express` a `multer` uvedené v `package.json`.

## Instalace a spuštění

Na Debianu nainstalujte Python a pandas:

```bash
sudo apt update
sudo apt install python3 python3-pandas
```

Nainstalujte Node.js 20+ a npm. Pokud používáte balíčky Debianu, nejdřív ověřte, že Node.js splňuje minimální verzi. Oficiální instalační možnosti jsou na [nodejs.org](https://nodejs.org/en/download/).

V kořeni projektu ověřte instalace a nainstalujte projektové balíčky:

```bash
python3 --version
python3 -c 'import pandas; print(pandas.__version__)'
node --version
npm --version
npm ci
```

Pak spusťte:

```bash
npm start
```

`npm start` nic neinstaluje. Před startem ověří, že je dostupný požadovaný Node.js, že `python3` je alespoň 3.10 a že v něm jde načíst pandas. Při chybě vypíše konkrétní pokyn. Server používá právě výchozí `python3`; pokud potřebujete jiný interpreter, lze nastavit `DIVIDENDY_PYTHON` na jeho příkazovou cestu. V prohlížeči otevřete `http://127.0.0.1:3000`. Aplikace naslouchá jen na loopbacku; nepřesměrovávejte port na síť. Proces zastavíte `Ctrl+C`.

## Import

Vyberte brokera a CSV. Aplikace přijímá pouze UTF-8 CSV do 5 MiB a parserem rozpoznané profily DEGIRO/IBKR. Náhled ukáže rozpoznané položky a diagnostiku. Po potvrzení zůstávají výsledky pouze v paměti do ukončení aplikace. Původní CSV se na disk neukládá. Obsahově shodný soubor stejného brokera se zablokuje jen v rámci aktuální relace.

Pokud formát neprojde, soubor nepřevádějte ani neupravujte podle odhadu. Ověřte typ exportu a zkontrolujte chybu parseru. Neznámé řádky zůstávají v diagnostice; kladná částka v sekci IBKR Withholding Tax se zobrazí jako neověřený daňový pohyb, nikoli jako potvrzená vratka.

Diagnostika stejného typu a se stejným vysvětlením je seskupena. Rozbalením skupiny zobrazíte jednotlivá čísla řádků. „Nezařazený záznam“ znamená, že parser záznam nerozpoznal jako podporovanou dividendu nebo daň, takže ho nezapočítal; může jít o jiný typ pohybu, ale bez rozpoznaného formátu to nelze potvrdit. „Nepodporovaná sekce“ se zachová jako upozornění a není zahrnuta do hotovostního přehledu. „Rozdílná datumová pole“ znamenají, že význam polí nebyl ověřen a datum je potřeba zkontrolovat. Chybějící datum se automaticky nedoplňuje. Diagnostika tak sama o sobě neznamená, že každý uvedený řádek je dividendová transakce.

## Kontrola a odebrání importu

Stav kontroly u transakce je zobrazen česky. Více zdrojových dividendových řádků sloučených pro stejné datum, měnu a identifikátor cenného papíru samo o sobě není nejednoznačné párování. Nepřiřazená daň z dividendy, rozdílná datumová pole, kladný neověřený daňový pohyb, nulový hrubý součet s vykázanou daní a podezřelé duplicity nadále vyžadují kontrolu.

Pokud DEGIRO dividenda a daň z dividendy sdílejí datum, měnu, produkt a ISIN, ale parser je kvůli rozdílným datumovým polím nemohl potvrzeně spárovat, tabulka je může zobrazit v jednom řádku jako kandidátní seskupení. Oba původní záznamy zůstávají samostatné v paměťové relaci a dostupné přes odkaz na zdrojový řádek. Souhrn je výslovně označen k ověření; zobrazení nepotvrzuje, že daň patří k dividendě.

Import odeberete otevřením jeho stránky z přehledu, volbou **Odebrat tento import…** a potvrzením tlačítkem. Z paměti zmizí import, transakce, diagnostika i ochrana proti opakování. Stejný soubor pak lze během relace znovu nahrát.

## Přehled a export

Souhrn lze filtrovat podle roku, brokera a měny. **Daň z dividendy** znamená částku vykázanou brokerem; sama o sobě neukazuje, zda je započitatelná v českém přiznání. **Čistá dividenda** je výsledek zpracování parserem. Položky s nejednoznačným párováním nebo neověřeným znaménkem mají stav kontroly. Detail ukazuje zdrojový název souboru a řádky.

**Neověřený daňový pohyb** je zvláštní kladná položka ze sekce IBKR Withholding Tax. Dostupné údaje nepotvrzují, jestli jde o vratku, opravu nebo jiný pohyb, proto se automaticky nepřiřazuje k dividendě a nepočítá se do daně z dividendy ani do čisté dividendy. Nula znamená, že parser žádnou takovou položku nenašel; v souhrnu se sloupec zobrazí jen tehdy, pokud existuje nenulová položka. Sloupec je součástí obou exportních formátů kvůli jednotné struktuře.

V horní navigaci jsou dvě tlačítka pro stažení právě zobrazených položek. **CSV** je textový export s desetinnou tečkou a středníkem mezi sloupci. Podle jazykového nastavení může tabulkový procesor částky otevřít jako text; pokud se to stane, použijte **Excel**. V XLSX jsou částky uloženy jako číselné buňky a jejich zobrazení se řídí nastavením tabulkového procesoru. Tabulkové procesory mají vlastní limit přesnosti čísel, proto je Excel vhodný pro běžné částky s několika desetinnými místy.

Oba exporty respektují aktivní filtry roku, brokera a měny. Jednoznačná kandidátní seskupení DEGIRO se exportují jako jeden řádek se součtem a poznámkou, že párování není potvrzené; oba původní řádky zůstávají uvedené ve sloupci zdrojových řádků ve formátu `2 + 3`. Hlavičky používají názvy **Daň z dividendy**, **Neověřený daňový pohyb** a **Čistá dividenda**. Textová pole v CSV jsou escapována proti spuštění vzorců v tabulkovém procesoru; pro účetní archiv uchovejte také původní brokerův export.

Na hlavní stránce lze nastavit typ a domicil všech titulů najednou tlačítkem **Uložit všechny změny domicilů**. Výchozí typ je „Běžná akcie“ a pole země je uzamčené; po uložení se použije země z prefixu ISINu pouze tehdy, když ISIN projde kontrolou kontrolní číslice a prefix odpovídá známé zemi. Když není návrh bezpečně dostupný, domicil zůstane neurčený. Toto pravidlo odpovídá popisu ISINu podle [ISO/TC 68](https://committee.iso.org/sites/tc68/home/articles/content-left-area/articles/what-is-isin.html). U ETF / fondu a „Jiného typu“ lze zadat kód země ručně. „Jiný typ“ vyberte například pro ADR/GDR a dluhopisy, jejichž ISIN prefix nelze bezpečně chápat jako domicil podkladové firmy: u ADR/GDR se prefix vztahuje k organizaci, která vydala depozitní certifikát, a dluhopisy mají odlišné pravidlo ([ANNA](https://anna-web.org/identifiers/)).

U ETF / fondu a jiného typu lze domicil zadat kódem země ISO 3166-1 alpha-2, například `US` nebo `DE`. Chcete-li domicil odebrat, klikněte u položky na **Vymazat** a pak odešlete společný formulář. Změny se nejprve celé ověří; při neplatném kódu se neuloží žádná z nich. Nastavení se sdílí pro stejný ISIN napříč brokery; pokud ISIN chybí, přiřazení se rozlišuje názvem titulu a brokerem. Domicil emitenta není země zdroje dividendy a neurčuje daňový režim. Souhrn podle domicilu zahrnuje všechny brokery a odděluje rok a měnu; neurčené tituly zůstávají viditelné zvlášť. Typy a domicily jsou pouze v paměti a po restartu se smažou. Exporty obsahují typ titulu, název i kód domicilu a původ údaje (odvozený prefix nebo ruční potvrzení).

## Soukromí a zachování výsledků

Aplikace nevytváří databázi, soubory importů ani zálohy. CSV se zpracuje v paměti Node.js a předá se Pythonu přes standardní vstup. Po zastavení nebo pádu aplikace se relace ztratí. Před ukončením stáhněte výsledky pomocí **CSV** nebo **Excel** exportu; zdrojový brokerův soubor si ponechte mimo aplikaci. Export může obsahovat citlivé finanční informace, proto s ním nakládejte stejně opatrně jako s původním výpisem.

## Omezení

Formáty parserů jsou omezené a synteticky testované; úplnost všech variant exportů není potvrzena. Data země zdroje příjmu nejsou dovozována z burzy, měny ani ISIN. Aplikace neobsahuje česká daňová pravidla, nepřipravuje daňové přiznání a nevyhodnocuje zahraniční zápočet.
