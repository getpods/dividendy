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

## Použití a data

Vyberte brokera a CSV soubor. Aplikace nejprve zobrazí náhled rozpoznaných záznamů a diagnostiku; import potvrďte až po kontrole. Výsledky a nahrané soubory zůstávají pouze v paměti a po ukončení aplikace se odstraní. Před ukončením si potřebné výsledky stáhněte přes **Export CSV**. Podrobný postup a vysvětlení diagnostiky najdete v [českém uživatelském návodu](docs/user-guide-cs.md).

Aplikace nic neodesílá do cloudu. Neznámé nebo nejednoznačné záznamy označuje ke kontrole a nepřiřazuje je automaticky. Zahraniční daň vykázaná brokerem není českým daňovým výpočtem ani potvrzením možnosti jejího zápočtu.
