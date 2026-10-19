# Dividendový přehled

Lokální česká aplikace pro zpracování dividendových CSV výpisů DEGIRO a IBKR. Částky zpracovává s desetinnou přesností a měny mezi sebou automaticky nepřevádí. Aplikace nepočítá českou daňovou povinnost ani nárok na zápočet zahraniční daně.

## Instalace a spuštění

Potřebujete Debian/Linux, Python 3.10 nebo novější s balíčkem `pandas`, Node.js 20 nebo novější a npm.

Na Debianu lze Python a pandas nainstalovat příkazem:

```bash
sudo apt update
sudo apt install python3 python3-pandas
```

Node.js a npm nainstalujte způsobem odpovídajícím vaší distribuci a ověřte jejich verze. V adresáři projektu pak spusťte:

```bash
npm ci
npm start
```

V prohlížeči otevřete `http://127.0.0.1:3000`. Server naslouchá pouze na místním počítači. Zastavíte jej klávesami `Ctrl+C`.

## Stažení výpisu od brokera

Pro úplný přehled za daný rok stáhněte CSV výpis s obdobím od 1. ledna do 31. prosince. Pokud se názvy položek v rozhraní brokera liší, hledejte roční výpis aktivit nebo přehled účtu s možností exportu do CSV.

### Interactive Brokers (IBKR)

1. Přihlaste se do **Client Portal**.
2. Otevřete **Performance Reports → Statements → Activity Statement**.
3. Nastavte vlastní období za celý rok, například **1. 1. 2025 až 31. 12. 2025**.
4. Stáhněte výpis volbou **Download CSV**.

### DEGIRO

1. Přihlaste se do svého účtu.
2. Otevřete **Inbox → Přehled účtu**.
3. Nastavte období od začátku do konce požadovaného roku.
4. Zvolte export do **CSV** a soubor stáhněte.

Stažený soubor neupravujte v tabulkovém procesoru před importem, protože uložení může změnit formát částek nebo sloupců. Ve webové aplikaci vyberte odpovídajícího brokera a nejprve zkontrolujte náhled a diagnostiku. Výpisy obsahují citlivé finanční údaje; aplikace je zpracovává lokálně a neukládá je po ukončení procesu.

## Použití a data

Vyberte brokera a CSV soubor. Aplikace nejprve zobrazí náhled rozpoznaných záznamů a diagnostiku; import potvrďte až po kontrole. Výsledky a nahrané soubory zůstávají pouze v paměti a po ukončení aplikace se odstraní. Před ukončením si potřebné výsledky stáhněte jako CSV nebo Excel. Excel export používá číselné buňky; CSV zachovává desetinnou tečku a středník mezi sloupci. Podrobný postup a vysvětlení diagnostiky najdete v [českém uživatelském návodu](docs/user-guide-cs.md).

Aplikace nic neodesílá do cloudu. Neznámé nebo nejednoznačné záznamy označuje ke kontrole a nepřiřazuje je automaticky. Zahraniční daň vykázaná brokerem není českým daňovým výpočtem ani potvrzením možnosti jejího zápočtu.
